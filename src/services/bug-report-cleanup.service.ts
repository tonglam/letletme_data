import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  bugReportRepository,
  type BugReportExpiryCursor,
  type StoredBugReport,
} from '../repositories/bug-reports';
import { logError, logInfo } from '../utils/logger';
import { isLegacyBugReportStorageLocator } from './bug-report-storage-migration.service';

const BATCH_SIZE = 100;
const STORAGE_REQUEST_TIMEOUT_MS = 15_000;
const STORAGE_OBJECT_MISSING_CODE = 'BUG_REPORT_STORAGE_OBJECT_MISSING';

function configuredStorageOrigins(): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of [
    process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN,
    process.env.BUG_REPORT_SCREENSHOT_SUPABASE_URL,
  ]) {
    if (!value?.trim()) continue;
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
        origins.add(parsed.origin);
      }
    } catch {
      // Configuration validation reports malformed values; cleanup treats the
      // locator as unknown and keeps the existing retry behaviour below.
    }
  }
  return origins;
}

function isPrivateBugReportStorageLocator(locator: string): boolean {
  const origins = configuredStorageOrigins();
  if (origins.size === 0) return false;
  const buckets = new Set(
    [
      process.env.BUG_REPORT_SCREENSHOT_BUCKET?.trim(),
      process.env.SUPABASE_BUG_REPORT_BUCKET?.trim(),
      'bug-report-screenshots',
      'bug-reports',
    ].filter((value): value is string => Boolean(value)),
  );
  try {
    const parsed = new URL(locator);
    if (
      parsed.protocol !== 'https:' ||
      !origins.has(parsed.origin) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    const decodedPath = decodeURIComponent(parsed.pathname);
    for (const bucket of buckets) {
      const prefix = `/storage/v1/object/${encodeURIComponent(bucket)}/`;
      if (!decodedPath.startsWith(prefix)) continue;
      const objectPath = decodedPath.slice(prefix.length);
      if (!objectPath.startsWith('bug-reports/')) return false;
      return objectPath
        .split('/')
        .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
    }
    return false;
  } catch {
    return false;
  }
}

function shouldAttemptRemoteDelete(locator: string): boolean {
  // The legacy-origin guard is deliberately required before classifying a
  // locator as managed. If the deployment is missing that setting, keep the
  // existing retry behaviour rather than silently leaking an object.
  const legacyOriginConfigured = Boolean(process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN?.trim());
  return (
    !legacyOriginConfigured ||
    isLegacyBugReportStorageLocator(locator) ||
    isPrivateBugReportStorageLocator(locator)
  );
}

function storageEndpoint(): string {
  const value = process.env.BUG_REPORT_STORAGE_INTERNAL_URL?.trim();
  if (!value) throw new Error('BUG_REPORT_STORAGE_INTERNAL_URL is not set');
  return value.replace(/\/$/, '');
}

async function deleteScreenshot(locator: string): Promise<void> {
  const secret = process.env.BUG_REPORT_CLEANUP_SECRET;
  if (!secret) throw new Error('BUG_REPORT_CLEANUP_SECRET is not set');
  const body = JSON.stringify({ locator });
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const routePath = new URL(`${storageEndpoint()}/delete`).pathname;
  const signature = createHmac('sha256', secret)
    .update(`POST.${routePath}.${timestamp}.${nonce}.${bodyHash}`)
    .digest('hex');
  const response = await fetch(`${storageEndpoint()}/delete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bug-report-timestamp': timestamp,
      'x-bug-report-nonce': nonce,
      'x-bug-report-body-sha256': bodyHash,
      'x-bug-report-signature': signature,
    },
    body,
    signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
  });
  const result = (await response.json().catch(() => null)) as {
    success?: unknown;
    code?: unknown;
    objectMissing?: unknown;
  } | null;
  // A prior cleanup attempt may have removed the object before the row was
  // deleted. Only the internal endpoint's explicit object-missing contract
  // is a confirmed terminal state; a generic route 404 remains retryable.
  if (!response.ok) {
    if (
      response.status === 404 &&
      result?.success === true &&
      result.code === STORAGE_OBJECT_MISSING_CODE &&
      result.objectMissing === true
    ) {
      return;
    }
    throw new Error(`Screenshot delete failed: ${response.status}`);
  }
  if (result?.success !== true) throw new Error('Screenshot delete was not confirmed');
}

export type BugReportCleanupResult = {
  scanned: number;
  deleted: number;
  retried: number;
};

export async function runBugReportCleanup(now = new Date()): Promise<BugReportCleanupResult> {
  let deleted = 0;
  let retried = 0;
  let scanned = 0;
  let cursor: BugReportExpiryCursor | undefined;

  while (true) {
    const expired = await bugReportRepository.listExpired(now, BATCH_SIZE, cursor);
    if (expired.length === 0) break;
    scanned += expired.length;

    for (const report of expired) {
      try {
        const claim = await bugReportRepository.claimForDeletion(report, now);
        if (!claim) continue;
        if (claim.completed) {
          deleted += 1;
          continue;
        }
        const removed = await bugReportRepository.finalizeClaimedDeletion(
          report.id,
          now,
          async () => {
            if (!claim.screenshotUrl) return false;
            if (!shouldAttemptRemoteDelete(claim.screenshotUrl)) {
              // The locator is outside the configured project/bucket. The
              // retention backup already contains the exact locator as a
              // scrubbed tombstone; retire the report without sending an
              // unmanageable URL to the internal storage endpoint.
              logInfo('Bug report screenshot locator retired without remote delete', {
                publicId: report.publicId,
              });
              return true;
            }
            await deleteScreenshot(claim.screenshotUrl);
            return true;
          },
        );
        if (removed !== false) deleted += 1;
      } catch (error) {
        retried += 1;
        logError('Bug report cleanup item failed', error, { publicId: report.publicId });
      }
    }

    if (expired.length < BATCH_SIZE) break;
    const last = expired.at(-1);
    if (!last) break;
    cursor = { expiresAt: last.expiresAt, id: last.id };
  }

  logInfo('Bug report cleanup completed', { scanned, deleted, retried });
  return { scanned, deleted, retried };
}

export async function deleteBugReportScreenshotForCleanup(report: StoredBugReport): Promise<void> {
  if (report.screenshotUrl && shouldAttemptRemoteDelete(report.screenshotUrl)) {
    await deleteScreenshot(report.screenshotUrl);
  }
}
