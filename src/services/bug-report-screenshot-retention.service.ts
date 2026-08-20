import { bugReportRepository, type ExpiredBugReportScreenshot } from '../repositories/bug-reports';
import { getConfig, type AppConfig } from '../utils/config';
import { logInfo, logWarn } from '../utils/logger';

const RETENTION_BATCH_SIZE = 100;
const RETENTION_MAX_DELETES = 1_000;
const STORAGE_SCAN_PAGE_SIZE = 100;
const STORAGE_REQUEST_TIMEOUT_MS = 10_000;
const STORAGE_OBJECT_KEY_PATTERN =
  /^bug-reports\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp|gif)$/i;

class StorageFatalError extends Error {}

function normalizeStorageObjectKey(prefix: string, name: string): string {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return name.startsWith(normalizedPrefix) ? name : `${normalizedPrefix}${name}`;
}

export type BugReportStorageObject = {
  name?: string;
  created_at?: string;
  createdAt?: string;
};

export type BugReportScreenshotBucket = {
  id?: string;
  name?: string;
  public?: boolean;
  file_size_limit?: number | string | null;
  allowed_mime_types?: string[] | null;
};

export interface BugReportScreenshotStorage {
  getBucket(): Promise<BugReportScreenshotBucket>;
  list(prefix: string, limit: number, offset: number): Promise<BugReportStorageObject[]>;
  remove(objectKey: string): Promise<'deleted' | 'missing'>;
}

export type BugReportScreenshotRetentionResult = {
  disabled: boolean;
  cutoff: Date;
  databaseScanned: number;
  deleteAttempts: number;
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

async function storageRequest<T>(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STORAGE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return await parse(response);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseJsonResponse(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) throw new Error(`Storage ${operation} failed with ${response.status}`);
  return response.json();
}

export function assertPrivateBugReportScreenshotBucket(
  bucket: BugReportScreenshotBucket,
  expectedName = 'bug-report-screenshots',
): void {
  if (bucket.name && bucket.name !== expectedName) {
    throw new Error('Bug-report screenshot storage returned an unexpected bucket');
  }
  if (bucket.public !== false) {
    throw new Error('Bug-report screenshot bucket must be private');
  }
}

export function createBugReportScreenshotStorage(
  config: AppConfig = getConfig(),
  fetchImpl: typeof fetch = fetch,
): BugReportScreenshotStorage {
  const headers = storageHeaders(config);
  const bucketName = config.BUG_REPORT_SCREENSHOT_BUCKET ?? 'bug-report-screenshots';
  return {
    async getBucket() {
      const payload = await storageRequest(
        `${storageBaseUrl(config)}/storage/v1/bucket/${encodeURIComponent(bucketName)}`,
        { method: 'GET', headers },
        fetchImpl,
        (response) => parseJsonResponse(response, 'bucket lookup'),
      );
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Storage bucket lookup returned an invalid response');
      }
      return payload as BugReportScreenshotBucket;
    },
    async list(prefix, limit, offset) {
      const listHeaders = new Headers(headers);
      listHeaders.set('content-type', 'application/json');
      const payload = await storageRequest(
        `${storageBaseUrl(config)}/storage/v1/object/list/${encodeURIComponent(bucketName)}`,
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
        fetchImpl,
        (response) => parseJsonResponse(response, 'list'),
      );
      if (!Array.isArray(payload)) throw new Error('Storage list returned an invalid response');
      return payload as BugReportStorageObject[];
    },
    async remove(objectKey) {
      return storageRequest(
        storagePath(config, objectKey),
        { method: 'DELETE', headers },
        fetchImpl,
        async (response) => {
          if (response.status === 404) {
            const responseBody = (await response.clone().text()).toLowerCase();
            const objectMissing =
              /object[\s_-]+not[\s_-]+found/.test(responseBody) ||
              /["']error["']\s*:\s*["']not_found["']/.test(responseBody);
            const bucketMissing = /bucket[\s_-]+not[\s_-]+found/.test(responseBody);
            if (objectMissing && !bucketMissing) return 'missing';
            throw new StorageFatalError('Storage delete returned an ambiguous not-found response');
          }
          if (!response.ok) throw new Error(`Storage delete failed with ${response.status}`);
          return 'deleted';
        },
      );
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
    deleteAttempts: 0,
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
  // Verify bucket/endpoint availability before mutating any database rows. A
  // missing bucket must not be mistaken for an absent object and clear refs.
  assertPrivateBugReportScreenshotBucket(await storage.getBucket());
  await storage.list('bug-reports/', 1, 0);
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
    if (baseResult.deleteAttempts >= RETENTION_MAX_DELETES) break;
    try {
      baseResult.deleteAttempts += 1;
      const outcome = await storage.remove(report.screenshotObjectKey);
      await repository.markScreenshotDeleted(report.id, now);
      if (outcome === 'missing') baseResult.missing += 1;
      else baseResult.deleted += 1;
    } catch (error) {
      if (error instanceof StorageFatalError) throw error;
      baseResult.failed += 1;
      logWarn('Bug-report screenshot deletion failed; will retry', {
        id: report.id,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  if (baseResult.deleteAttempts < RETENTION_MAX_DELETES && protectedScanComplete) {
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
          orphanCandidates.length >= RETENTION_MAX_DELETES
        ) {
          continue;
        }
        orphanCandidates.push(objectKey);
      }
      if (page.length < STORAGE_SCAN_PAGE_SIZE || baseResult.orphanScanned >= RETENTION_MAX_DELETES)
        break;
    }
    for (const objectKey of orphanCandidates) {
      if (baseResult.deleteAttempts >= RETENTION_MAX_DELETES) break;
      try {
        baseResult.deleteAttempts += 1;
        await storage.remove(objectKey);
        baseResult.orphanDeleted += 1;
      } catch (error) {
        if (error instanceof StorageFatalError) throw error;
        baseResult.failed += 1;
        logWarn('Orphan bug-report screenshot deletion failed; will retry', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  } else if (baseResult.deleteAttempts < RETENTION_MAX_DELETES) {
    logWarn('Skipping orphan screenshot scan because active database keys exceeded the scan cap');
  }

  logInfo('Bug-report screenshot retention completed', {
    cutoff: cutoff.toISOString(),
    databaseScanned: baseResult.databaseScanned,
    deleteAttempts: baseResult.deleteAttempts,
    deleted: baseResult.deleted,
    missing: baseResult.missing,
    orphanScanned: baseResult.orphanScanned,
    orphanDeleted: baseResult.orphanDeleted,
    failed: baseResult.failed,
  });
  return baseResult;
}
