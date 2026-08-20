import { describe, expect, test } from 'bun:test';

import { isLegacyBugReportStorageLocator } from '../../src/services/bug-report-storage-migration.service';

describe('bug report storage migration locator gate', () => {
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
  });
});
