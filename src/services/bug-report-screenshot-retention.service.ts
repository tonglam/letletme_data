import { bugReportRepository, type ExpiredBugReportScreenshot } from '../repositories/bug-reports';
import { getConfig, type AppConfig } from '../utils/config';
import { logInfo, logWarn } from '../utils/logger';

const RETENTION_BATCH_SIZE = 100;
const RETENTION_MAX_DELETES = 1_000;
const STORAGE_SCAN_PAGE_SIZE = 100;
const STORAGE_OBJECT_KEY_PATTERN =
  /^bug-reports\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp|gif)$/i;

function normalizeStorageObjectKey(prefix: string, name: string): string {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return name.startsWith(normalizedPrefix) ? name : `${normalizedPrefix}${name}`;
}

export type BugReportStorageObject = {
  name?: string;
  created_at?: string;
  createdAt?: string;
};

export interface BugReportScreenshotStorage {
  list(prefix: string, limit: number, offset: number): Promise<BugReportStorageObject[]>;
  remove(objectKey: string): Promise<'deleted' | 'missing'>;
}

export type BugReportScreenshotRetentionResult = {
  disabled: boolean;
  cutoff: Date;
  databaseScanned: number;
  deleted: number;
  missing: number;
  orphanScanned: number;
  orphanDeleted: number;
  failed: number;
};

function storageHeaders(config: AppConfig): Headers {
  const key = config.BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY;
  if (!key) throw new Error('Bug-report screenshot storage key is not configured');
  return new Headers({ apikey: key, authorization: `Bearer ${key}` });
}

function storageBaseUrl(config: AppConfig): string {
  const value = config.BUG_REPORT_SCREENSHOT_SUPABASE_URL;
  if (!value) throw new Error('Bug-report screenshot storage URL is not configured');
  return value.replace(/\/$/, '');
}

function storagePath(config: AppConfig, objectKey?: string): string {
  const bucket = encodeURIComponent(
    config.BUG_REPORT_SCREENSHOT_BUCKET ?? 'bug-report-screenshots',
  );
  const suffix = objectKey
    ? `/${objectKey
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')}`
    : '';
  return `${storageBaseUrl(config)}/storage/v1/object/${bucket}${suffix}`;
}

export function createBugReportScreenshotStorage(
  config: AppConfig = getConfig(),
  fetchImpl: typeof fetch = fetch,
): BugReportScreenshotStorage {
  const headers = storageHeaders(config);
  return {
    async list(prefix, limit, offset) {
      const listHeaders = new Headers(headers);
      listHeaders.set('content-type', 'application/json');
      const response = await fetchImpl(
        `${storageBaseUrl(config)}/storage/v1/object/list/${encodeURIComponent(config.BUG_REPORT_SCREENSHOT_BUCKET ?? 'bug-report-screenshots')}`,
        {
          method: 'POST',
          headers: listHeaders,
          body: JSON.stringify({
            prefix,
            limit,
            offset,
            sortBy: { column: 'created_at', order: 'asc' },
          }),
        },
      );
      if (!response.ok) throw new Error(`Storage list failed with ${response.status}`);
      const payload = (await response.json()) as unknown;
      if (!Array.isArray(payload)) throw new Error('Storage list returned an invalid response');
      return payload as BugReportStorageObject[];
    },
    async remove(objectKey) {
      const response = await fetchImpl(storagePath(config, objectKey), {
        method: 'DELETE',
        headers,
      });
      if (response.status === 404) return 'missing';
      if (!response.ok) throw new Error(`Storage delete failed with ${response.status}`);
      return 'deleted';
    },
  };
}

function objectCreatedAt(object: BugReportStorageObject): Date | null {
  const raw = object.created_at ?? object.createdAt;
  if (!raw) return null;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
}

export async function runBugReportScreenshotRetention(
  options: {
    now?: Date;
    config?: AppConfig;
    storage?: BugReportScreenshotStorage;
    repository?: Pick<
      typeof bugReportRepository,
      'listExpiredScreenshots' | 'listActiveScreenshotKeys' | 'markScreenshotDeleted'
    >;
  } = {},
): Promise<BugReportScreenshotRetentionResult> {
  const config = options.config ?? getConfig();
  const now = options.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - (config.BUG_REPORT_SCREENSHOT_RETENTION_DAYS ?? 90) * 86_400_000,
  );
  const baseResult: BugReportScreenshotRetentionResult = {
    disabled: config.BUG_REPORT_SCREENSHOT_STORAGE_ENABLED !== true,
    cutoff,
    databaseScanned: 0,
    deleted: 0,
    missing: 0,
    orphanScanned: 0,
    orphanDeleted: 0,
    failed: 0,
  };
  if (config.BUG_REPORT_SCREENSHOT_STORAGE_ENABLED !== true) {
    logInfo('Bug-report screenshot retention disabled');
    return baseResult;
  }

  const storage = options.storage ?? createBugReportScreenshotStorage(config);
  const repository = options.repository ?? bugReportRepository;
  const expired: ExpiredBugReportScreenshot[] = [];
  for (let offset = 0; offset < RETENTION_MAX_DELETES; offset += RETENTION_BATCH_SIZE) {
    const page = await repository.listExpiredScreenshots(cutoff, RETENTION_BATCH_SIZE, offset);
    expired.push(...page);
    if (page.length < RETENTION_BATCH_SIZE) break;
  }
  baseResult.databaseScanned = expired.length;

  const protectedKeys = new Set<string>();
  let protectedScanComplete = false;
  for (let offset = 0; offset < RETENTION_MAX_DELETES; offset += RETENTION_BATCH_SIZE) {
    const page = await repository.listActiveScreenshotKeys(RETENTION_BATCH_SIZE, offset);
    for (const key of page) protectedKeys.add(key);
    if (page.length < RETENTION_BATCH_SIZE) {
      protectedScanComplete = true;
      break;
    }
  }

  for (const report of expired) {
    if (baseResult.deleted + baseResult.missing >= RETENTION_MAX_DELETES) break;
    try {
      const outcome = await storage.remove(report.screenshotObjectKey);
      await repository.markScreenshotDeleted(report.id, now);
      if (outcome === 'missing') baseResult.missing += 1;
      else baseResult.deleted += 1;
    } catch (error) {
      baseResult.failed += 1;
      logWarn('Bug-report screenshot deletion failed; will retry', {
        id: report.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  const orphanBudget = RETENTION_MAX_DELETES - baseResult.deleted - baseResult.missing;
  if (orphanBudget > 0 && protectedScanComplete) {
    const orphanCandidates: string[] = [];
    for (let offset = 0; offset < RETENTION_MAX_DELETES; offset += STORAGE_SCAN_PAGE_SIZE) {
      const page = await storage.list('bug-reports/', STORAGE_SCAN_PAGE_SIZE, offset);
      if (page.length === 0) break;
      for (const object of page) {
        if (baseResult.orphanScanned >= RETENTION_MAX_DELETES) break;
        baseResult.orphanScanned += 1;
        const objectKey = normalizeStorageObjectKey('bug-reports/', object.name ?? '');
        const createdAt = objectCreatedAt(object);
        if (
          !STORAGE_OBJECT_KEY_PATTERN.test(objectKey) ||
          !createdAt ||
          createdAt > cutoff ||
          protectedKeys.has(objectKey) ||
          orphanCandidates.length >= orphanBudget
        ) {
          continue;
        }
        orphanCandidates.push(objectKey);
      }
      if (page.length < STORAGE_SCAN_PAGE_SIZE || baseResult.orphanScanned >= RETENTION_MAX_DELETES)
        break;
    }
    for (const objectKey of orphanCandidates) {
      try {
        await storage.remove(objectKey);
        baseResult.orphanDeleted += 1;
      } catch (error) {
        baseResult.failed += 1;
        logWarn('Orphan bug-report screenshot deletion failed; will retry', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  } else if (orphanBudget > 0) {
    logWarn('Skipping orphan screenshot scan because active database keys exceeded the scan cap');
  }

  logInfo('Bug-report screenshot retention completed', {
    cutoff: cutoff.toISOString(),
    databaseScanned: baseResult.databaseScanned,
    deleted: baseResult.deleted,
    missing: baseResult.missing,
    orphanScanned: baseResult.orphanScanned,
    orphanDeleted: baseResult.orphanDeleted,
    failed: baseResult.failed,
  });
  return baseResult;
}
