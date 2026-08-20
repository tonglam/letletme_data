import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { isLegacyBugReportStorageLocator } from '../../src/services/bug-report-storage-migration.service';

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
});
