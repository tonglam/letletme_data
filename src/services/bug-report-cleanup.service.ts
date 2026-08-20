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

function shouldAttemptRemoteDelete(locator: string): boolean {
  // The legacy-origin guard is deliberately required before classifying a
  // locator as managed. If the deployment is missing that setting, keep the
  // existing retry behaviour rather than silently leaking an object.
  const legacyOriginConfigured = Boolean(process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN?.trim());
  return !legacyOriginConfigured || isLegacyBugReportStorageLocator(locator);
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
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${bodyHash}`)
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
