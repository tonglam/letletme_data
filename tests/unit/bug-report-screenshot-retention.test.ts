import { describe, expect, it } from 'bun:test';

import {
  createBugReportScreenshotStorage,
  runBugReportScreenshotRetention,
  type BugReportScreenshotStorage,
} from '../../src/services/bug-report-screenshot-retention.service';
import type { AppConfig } from '../../src/utils/config';

const config = {
  BUG_REPORT_SCREENSHOT_STORAGE_ENABLED: true,
  BUG_REPORT_SCREENSHOT_RETENTION_DAYS: 90,
  BUG_REPORT_SCREENSHOT_BUCKET: 'bug-report-screenshots',
  BUG_REPORT_SCREENSHOT_SUPABASE_URL: 'https://example.supabase.co',
  BUG_REPORT_SCREENSHOT_SUPABASE_SECRET_KEY: 'secret',
} as AppConfig;

const submissionId = '550e8400-e29b-41d4-a716-446655440000';
const key = `bug-reports/${submissionId}.png`;

describe('bug-report screenshot retention', () => {
  it('deletes expired rows, confirms missing objects, and removes old orphans', async () => {
    const marked: string[] = [];
    const removed: string[] = [];
    const storage: BugReportScreenshotStorage = {
      async list() {
        return [
          { name: key, created_at: '2026-01-01T00:00:00.000Z' },
          {
            name: '650e8400-e29b-41d4-a716-446655440000.jpg',
            created_at: '2026-01-01T00:00:00.000Z',
          },
          {
            name: 'bug-reports/750e8400-e29b-41d4-a716-446655440000.gif',
            created_at: '2026-08-01T00:00:00.000Z',
          },
        ];
      },
      async remove(objectKey) {
        removed.push(objectKey);
        return objectKey === key ? 'missing' : 'deleted';
      },
    };
    const result = await runBugReportScreenshotRetention({
      now: new Date('2026-08-20T00:00:00.000Z'),
      config,
      storage,
      repository: {
        async listExpiredScreenshots() {
          return [{ id: 'report-1', screenshotObjectKey: key, createdAt: new Date('2026-01-01') }];
        },
        async listActiveScreenshotKeys() {
          return [key];
        },
        async markScreenshotDeleted(id) {
          marked.push(id);
        },
      },
    });

    expect(result.missing).toBe(1);
    expect(result.orphanDeleted).toBe(1);
    expect(result.failed).toBe(0);
    expect(marked).toEqual(['report-1']);
    expect(removed).toEqual([key, 'bug-reports/650e8400-e29b-41d4-a716-446655440000.jpg']);
  });

  it('does not touch storage while the feature is disabled', async () => {
    let calls = 0;
    const result = await runBugReportScreenshotRetention({
      config: { ...config, BUG_REPORT_SCREENSHOT_STORAGE_ENABLED: false },
      storage: {
        async list() {
          calls += 1;
          return [];
        },
        async remove() {
          calls += 1;
          return 'deleted';
        },
      },
      repository: {
        async listExpiredScreenshots() {
          calls += 1;
          return [];
        },
        async listActiveScreenshotKeys() {
          calls += 1;
          return [];
        },
        async markScreenshotDeleted() {
          calls += 1;
        },
      },
    });
    expect(result.disabled).toBe(true);
    expect(calls).toBe(0);
  });

  it('does not classify a bucket-level 404 as a missing object', async () => {
    const storage = createBugReportScreenshotStorage(
      config,
      (async () =>
        new Response(JSON.stringify({ message: 'Bucket not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    );

    await expect(storage.remove(key)).rejects.toThrow(/ambiguous not-found/);

    const objectStorage = createBugReportScreenshotStorage(
      config,
      (async () =>
        new Response(JSON.stringify({ error: 'not_found', message: 'Object not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    );
    await expect(objectStorage.remove(key)).resolves.toBe('missing');
  });

  it('shares the 1,000-delete budget across database failures and orphan cleanup', async () => {
    let removeCalls = 0;
    const storage: BugReportScreenshotStorage = {
      async list() {
        return [
          {
            name: 'bug-reports/650e8400-e29b-41d4-a716-446655440000.jpg',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ];
      },
      async remove() {
        removeCalls += 1;
        throw new Error('storage unavailable');
      },
    };
    const result = await runBugReportScreenshotRetention({
      now: new Date('2026-08-20T00:00:00.000Z'),
      config,
      storage,
      repository: {
        async listExpiredScreenshots(_cutoff, _limit, offset) {
          const start = offset ?? 0;
          if (start >= 1_000) return [];
          return Array.from({ length: 100 }, (_, index) => ({
            id: `report-${start + index}`,
            screenshotObjectKey: `bug-reports/${String(start + index).padStart(8, '0')}-e29b-41d4-a716-446655440000.jpg`,
            createdAt: new Date('2026-01-01'),
          }));
        },
        async listActiveScreenshotKeys() {
          return [];
        },
        async markScreenshotDeleted() {
          throw new Error('should not mark failed deletes');
        },
      },
    });

    expect(result.deleteAttempts).toBe(1_000);
    expect(result.failed).toBe(1_000);
    expect(result.orphanScanned).toBe(0);
    expect(removeCalls).toBe(1_000);
  });

  it('counts successful, missing, and failed deletes in the same budget', async () => {
    const removed: string[] = [];
    let listCalls = 0;
    const orphanKey = 'bug-reports/750e8400-e29b-41d4-a716-446655440000.gif';
    const storage: BugReportScreenshotStorage = {
      async list() {
        listCalls += 1;
        return listCalls === 1 ? [] : [{ name: orphanKey, created_at: '2026-01-01T00:00:00.000Z' }];
      },
      async remove(objectKey) {
        removed.push(objectKey);
        if (objectKey.endsWith('.png')) throw new Error('temporary failure');
        if (objectKey.endsWith('.jpg')) return 'missing';
        return 'deleted';
      },
    };
    const result = await runBugReportScreenshotRetention({
      now: new Date('2026-08-20T00:00:00.000Z'),
      config,
      storage,
      repository: {
        async listExpiredScreenshots() {
          return [
            {
              id: 'failed',
              screenshotObjectKey: 'bug-reports/failed.png',
              createdAt: new Date('2026-01-01'),
            },
            {
              id: 'missing',
              screenshotObjectKey: 'bug-reports/missing.jpg',
              createdAt: new Date('2026-01-01'),
            },
          ];
        },
        async listActiveScreenshotKeys() {
          return [];
        },
        async markScreenshotDeleted() {},
      },
    });

    expect(result.deleteAttempts).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.missing).toBe(1);
    expect(result.orphanDeleted).toBe(1);
    expect(removed).toEqual(['bug-reports/failed.png', 'bug-reports/missing.jpg', orphanKey]);
  });

  it('treats an orphan created exactly at the 90-day cutoff as eligible', async () => {
    const cutoffObject = 'bug-reports/850e8400-e29b-41d4-a716-446655440000.webp';
    let listCalls = 0;
    const removed: string[] = [];
    const storage: BugReportScreenshotStorage = {
      async list() {
        listCalls += 1;
        return listCalls === 1
          ? []
          : [{ name: cutoffObject, created_at: '2026-05-22T00:00:00.000Z' }];
      },
      async remove(objectKey) {
        removed.push(objectKey);
        return 'deleted';
      },
    };
    const result = await runBugReportScreenshotRetention({
      now: new Date('2026-08-20T00:00:00.000Z'),
      config,
      storage,
      repository: {
        async listExpiredScreenshots() {
          return [];
        },
        async listActiveScreenshotKeys() {
          return [];
        },
        async markScreenshotDeleted() {},
      },
    });

    expect(result.orphanDeleted).toBe(1);
    expect(removed).toEqual([cutoffObject]);
  });
});
