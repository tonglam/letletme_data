import { createHash, createHmac, randomUUID } from 'node:crypto';

import {
  bugReportRepository,
  type BugReportScreenshotCursor,
  type BugReportRepository,
} from '../repositories/bug-reports';
import { logError, logInfo, logWarn } from '../utils/logger';

const BATCH_SIZE = 100;
const STORAGE_REQUEST_TIMEOUT_MS = 15_000;
const STORAGE_OBJECT_MISSING_CODE = 'BUG_REPORT_STORAGE_OBJECT_MISSING';
const LEGACY_BUCKET = 'letletme';
const LEGACY_PREFIX = `/storage/v1/object/public/${LEGACY_BUCKET}/bug-reports/`;

export type BugReportStorageMigrationResult = {
  scanned: number;
  candidates: number;
  migrated: number;
  deletedRetried: number;
  failed: number;
  dryRun: boolean;
};

function storageEndpoint(): string {
  const value = process.env.BUG_REPORT_STORAGE_INTERNAL_URL?.trim();
  if (!value) throw new Error('BUG_REPORT_STORAGE_INTERNAL_URL is not set');
  return value.replace(/\/$/, '');
}

function configuredLegacyOrigin(): string | null {
  const configuredOrigin = process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN?.trim();
  if (!configuredOrigin) return null;
  try {
    const parsed = new URL(configuredOrigin);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

export function assertLegacyBugReportStorageConfig(): string {
  const origin = configuredLegacyOrigin();
  if (!origin) {
    throw new Error('BUG_REPORT_STORAGE_LEGACY_ORIGIN is not set or is not a valid HTTPS origin');
  }
  return origin;
}

/** Only old public objects in the configured Supabase project's avatar bucket are candidates. */
export function isLegacyBugReportStorageLocator(locator: string): boolean {
  try {
    const parsed = new URL(locator);
    const expectedOrigin = configuredLegacyOrigin();
    if (
      !expectedOrigin ||
      parsed.protocol !== 'https:' ||
      parsed.origin !== expectedOrigin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (!decodedPath.startsWith(LEGACY_PREFIX)) return false;
    const objectPath = decodedPath.slice(LEGACY_PREFIX.length);
    return (
      objectPath.length > 0 &&
      !objectPath
        .split('/')
        .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    );
  } catch {
    return false;
  }
}

async function callStorage(
  operation: 'migrate' | 'delete',
  locator: string,
): Promise<string | null> {
  const secret = process.env.BUG_REPORT_CLEANUP_SECRET;
  if (!secret) throw new Error('BUG_REPORT_CLEANUP_SECRET is not set');
  const body = JSON.stringify({ locator });
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${bodyHash}`)
    .digest('hex');
  const response = await fetch(`${storageEndpoint()}/${operation}`, {
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
    success?: boolean;
    locator?: unknown;
    code?: unknown;
    objectMissing?: unknown;
  } | null;
  // DELETE is intentionally idempotent: an earlier attempt may have removed
  // the object before the database completion marker was committed. Only the
  // internal endpoint's explicit object-missing contract counts as success;
  // a generic route 404 is fatal.
  if (!response.ok) {
    if (
      operation === 'delete' &&
      response.status === 404 &&
      result?.success === true &&
      result.code === STORAGE_OBJECT_MISSING_CODE &&
      result.objectMissing === true
    ) {
      return null;
    }
    throw new Error(`Storage ${operation} failed: ${response.status}`);
  }
  if (result?.success !== true) throw new Error(`Storage ${operation} rejected`);
  return operation === 'migrate' && typeof result.locator === 'string' ? result.locator : null;
}

export async function runBugReportStorageMigration(
  options: {
    dryRun?: boolean;
    limit?: number;
    now?: Date;
    repository?: BugReportRepository;
  } = {},
): Promise<BugReportStorageMigrationResult> {
  const dryRun = options.dryRun ?? true;
  const limit = Math.min(Math.max(options.limit ?? BATCH_SIZE, 1), BATCH_SIZE);
  const repository = options.repository ?? bugReportRepository;
  assertLegacyBugReportStorageConfig();
  const result: BugReportStorageMigrationResult = {
    scanned: 0,
    candidates: 0,
    migrated: 0,
    deletedRetried: 0,
    failed: 0,
    dryRun,
  };

  const candidateReportsBySource = new Map<string, { publicId: string; count: number }>();
  let cursor: BugReportScreenshotCursor | undefined;
  while (true) {
    const reports = await repository.listWithScreenshots(limit, cursor);
    if (reports.length === 0) break;
    result.scanned += reports.length;
    for (const report of reports) {
      const sourceLocator = report.screenshotUrl;
      if (!sourceLocator || !isLegacyBugReportStorageLocator(sourceLocator)) continue;
      result.candidates += 1;
      const sourceReport = candidateReportsBySource.get(sourceLocator);
      if (sourceReport) {
        sourceReport.count += 1;
      } else {
        candidateReportsBySource.set(sourceLocator, { publicId: report.publicId, count: 1 });
      }
    }
    if (reports.length < limit) break;
    const last = reports.at(-1);
    if (!last) break;
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  if (dryRun) {
    logInfo('Bug report storage migration dry-run completed', {
      scanned: result.scanned,
      candidates: result.candidates,
    });
    return result;
  }

  let pendingCursor: { migratedAt: Date; id: string } | undefined;
  while (true) {
    const pendingDeletes = await repository.listPendingStorageDeletes(limit, pendingCursor);
    if (pendingDeletes.length === 0) break;
    for (const pending of pendingDeletes) {
      // This source already has a durable target. Whether the remote delete
      // succeeds or remains retryable, never run /migrate again in this pass.
      candidateReportsBySource.delete(pending.sourceLocator);
      try {
        await repository.migrateAndDeleteStorageLocator(
          pending.sourceLocator,
          pending.targetLocator,
          () => callStorage('delete', pending.sourceLocator).then(() => undefined),
          options.now,
        );
        result.deletedRetried += 1;
      } catch (error) {
        result.failed += 1;
        logWarn('Bug report storage delete retry failed', {
          code: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    if (pendingDeletes.length < limit) break;
    const last = pendingDeletes.at(-1);
    if (!last) break;
    pendingCursor = { migratedAt: last.migratedAt, id: last.id };
  }

  for (const [sourceLocator, report] of candidateReportsBySource) {
    try {
      const migrateCandidate = () =>
        repository.migrateAndDeleteStorageLocator(
          sourceLocator,
          async () => {
            const migratedLocator = await callStorage('migrate', sourceLocator);
            if (!migratedLocator) throw new Error('Storage migration returned no locator');
            return migratedLocator;
          },
          () => callStorage('delete', sourceLocator).then(() => undefined),
          options.now,
        );
      let migrated = await migrateCandidate();
      if (!migrated) {
        // A report can commit after the inventory scan but before the
        // repository's second fence. Retry once so the apply command cannot
        // silently leave a live legacy locator without a durable migration.
        migrated = await migrateCandidate();
      }
      if (migrated) result.migrated += report.count;
      else if ((await repository.listByScreenshotUrl(sourceLocator)).length > 0) {
        result.failed += 1;
        logWarn('Bug report storage migration candidate remained live after retry', {
          code: 'BUG_REPORT_STORAGE_MIGRATION_RACE',
        });
      }
    } catch (error) {
      result.failed += 1;
      logError('Bug report storage migration item failed', error, {
        code: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  logInfo('Bug report storage migration completed', {
    scanned: result.scanned,
    candidates: result.candidates,
    migrated: result.migrated,
    deletedRetried: result.deletedRetried,
    failed: result.failed,
  });
  return result;
}
