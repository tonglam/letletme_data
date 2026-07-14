import { describe, expect, test } from 'bun:test';

import { shouldMarkEntryInfoSynced } from '../../src/jobs/entry-info-sync-marker';

describe('shouldMarkEntryInfoSynced', () => {
  test('marks only the final chunk with zero failures', () => {
    expect(shouldMarkEntryInfoSynced(false, 0)).toBe(true);
  });

  test('does not mark mid-chunk success', () => {
    expect(shouldMarkEntryInfoSynced(true, 0)).toBe(false);
  });

  test('does not mark the final chunk while failures remain', () => {
    expect(shouldMarkEntryInfoSynced(false, 3)).toBe(false);
  });

  test('does not mark a mid-chunk that also has failures', () => {
    expect(shouldMarkEntryInfoSynced(true, 1)).toBe(false);
  });
});
