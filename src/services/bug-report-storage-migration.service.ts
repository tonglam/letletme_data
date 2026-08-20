import { createHash, createHmac, randomUUID } from 'node:crypto';

import { bugReportRepository } from '../repositories/bug-reports';
import { logError, logInfo, logWarn } from '../utils/logger';

const BATCH_SIZE = 100;
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
  });
  if (!response.ok) throw new Error(`Storage ${operation} failed: ${response.status}`);
  const result = (await response.json()) as { success?: boolean; locator?: unknown };
  if (!result.success) throw new Error(`Storage ${operation} rejected`);
  return operation === 'migrate' && typeof result.locator === 'string' ? result.locator : null;
}

export async function runBugReportStorageMigration(
  options: {
    dryRun?: boolean;
    limit?: number;
    now?: Date;
  } = {},
): Promise<BugReportStorageMigrationResult> {
  const dryRun = options.dryRun ?? true;
  const limit = Math.min(Math.max(options.limit ?? BATCH_SIZE, 1), BATCH_SIZE);
  const reports = await bugReportRepository.listWithScreenshots(limit);
  const candidates = reports.filter(
    (report) => report.screenshotUrl && isLegacyBugReportStorageLocator(report.screenshotUrl),
  );
  const result: BugReportStorageMigrationResult = {
    scanned: reports.length,
    candidates: candidates.length,
    migrated: 0,
    deletedRetried: 0,
    failed: 0,
    dryRun,
  };

  if (dryRun) {
    logInfo('Bug report storage migration dry-run completed', {
      scanned: result.scanned,
      candidates: result.candidates,
    });
    return result;
  }

  const pendingDeletes = await bugReportRepository.listPendingStorageDeletes(limit);
  for (const pending of pendingDeletes) {
    try {
      await callStorage('delete', pending.sourceLocator);
      await bugReportRepository.markStorageDeleted(pending.sourceLocator, options.now);
      result.deletedRetried += 1;
    } catch (error) {
      result.failed += 1;
      logWarn('Bug report storage delete retry failed', {
        code: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  for (const report of candidates) {
    const sourceLocator = report.screenshotUrl;
    if (!sourceLocator) continue;
    try {
      const migratedLocator = await callStorage('migrate', sourceLocator);
      if (!migratedLocator) throw new Error('Storage migration returned no locator');
      const migration = await bugReportRepository.recordStorageMigration(
        report.publicId,
        sourceLocator,
        migratedLocator,
      );
      const targetLocator = migration?.targetLocator ?? migratedLocator;
      const updated = await bugReportRepository.updateScreenshotUrl(
        report.publicId,
        sourceLocator,
        targetLocator,
      );
      if (!updated) {
        const current = await bugReportRepository.findByPublicId(report.publicId);
        if (current?.screenshotUrl !== targetLocator) {
          throw new Error('Storage migration compare-and-swap lost');
        }
      }
      await callStorage('delete', sourceLocator);
      await bugReportRepository.markStorageDeleted(sourceLocator, options.now);
      result.migrated += 1;
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
