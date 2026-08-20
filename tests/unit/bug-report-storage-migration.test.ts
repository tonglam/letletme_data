import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { isLegacyBugReportStorageLocator } from '../../src/services/bug-report-storage-migration.service';
import { runBugReportStorageMigration } from '../../src/services/bug-report-storage-migration.service';
import type { BugReportRepository } from '../../src/repositories/bug-reports';

describe('bug report storage migration locator gate', () => {
  const originalOrigin = process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN;

  beforeAll(() => {
    process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN = 'https://project.supabase.co';
  });

  afterAll(() => {
    if (originalOrigin === undefined) delete process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN;
    else process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN = originalOrigin;
  });

  test('accepts only the historical public avatar-bucket prefix', () => {
    expect(
      isLegacyBugReportStorageLocator(
        'https://project.supabase.co/storage/v1/object/public/letletme/bug-reports/old.png',
      ),
    ).toBe(true);
    expect(
      isLegacyBugReportStorageLocator(
        'https://project.supabase.co/storage/v1/object/bug-reports/bug-reports/new.png',
      ),
    ).toBe(false);
  });

  test('rejects traversal, unrelated buckets, and malformed locators', () => {
    expect(
      isLegacyBugReportStorageLocator(
        'https://project.supabase.co/storage/v1/object/public/letletme/bug-reports/../avatar.png',
      ),
    ).toBe(false);
    expect(
      isLegacyBugReportStorageLocator(
        'https://project.supabase.co/storage/v1/object/public/other/bug-reports/old.png',
      ),
    ).toBe(false);
    expect(isLegacyBugReportStorageLocator('not-a-url')).toBe(false);
    expect(
      isLegacyBugReportStorageLocator(
        'https://project.supabase.co/storage/v1/object/public/letletme/bug-reports/%2e%2e/avatar.png',
      ),
    ).toBe(false);
  });

  test('fails closed when the project origin is not configured', () => {
    delete process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN;
    expect(
      isLegacyBugReportStorageLocator(
        'https://project.supabase.co/storage/v1/object/public/letletme/bug-reports/old.png',
      ),
    ).toBe(false);
    process.env.BUG_REPORT_STORAGE_LEGACY_ORIGIN = 'https://project.supabase.co';
  });

  test('treats an already-absent source as a successful delete retry', async () => {
    const originalFetch = globalThis.fetch;
    const originalInternalUrl = process.env.BUG_REPORT_STORAGE_INTERNAL_URL;
    const originalSecret = process.env.BUG_REPORT_CLEANUP_SECRET;
    process.env.BUG_REPORT_STORAGE_INTERNAL_URL = 'https://web.example.test/internal/storage';
    process.env.BUG_REPORT_CLEANUP_SECRET = 's'.repeat(64);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          code: 'BUG_REPORT_STORAGE_OBJECT_MISSING',
          objectMissing: true,
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const repository = {
      listWithScreenshots: async () => [],
      listPendingStorageDeletes: async () => [
        {
          id: 'migration-1',
          publicId: 'report-1',
          sourceLocator:
            'https://project.supabase.co/storage/v1/object/public/letletme/bug-reports/old.png',
          targetLocator:
            'https://project.supabase.co/storage/v1/object/bug-reports/bug-reports/new.png',
          migratedAt: new Date('2026-08-20T00:00:00.000Z'),
        },
      ],
      migrateAndDeleteStorageLocator: async (
        _sourceLocator: string,
        _targetLocator: string,
        deleteSource: () => Promise<void>,
      ) => {
        await deleteSource();
      },
    } as unknown as BugReportRepository;

    try {
      await expect(
        runBugReportStorageMigration({ dryRun: false, repository }),
      ).resolves.toMatchObject({ deletedRetried: 1, failed: 0 });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalInternalUrl === undefined) delete process.env.BUG_REPORT_STORAGE_INTERNAL_URL;
      else process.env.BUG_REPORT_STORAGE_INTERNAL_URL = originalInternalUrl;
      if (originalSecret === undefined) delete process.env.BUG_REPORT_CLEANUP_SECRET;
      else process.env.BUG_REPORT_CLEANUP_SECRET = originalSecret;
    }
  });
});
