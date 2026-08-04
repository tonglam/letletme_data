import { describe, expect, test } from 'bun:test';

import { shouldMarkEntryInfoSynced } from '../../src/jobs/entry-info-sync-marker';

describe('shouldMarkEntryInfoSynced', () => {
  test('marks only the final chunk with zero failures', () => {
    expect(shouldMarkEntryInfoSynced(true, false, 0)).toBe(true);
  });

  test('does not mark mid-chunk success', () => {
    expect(shouldMarkEntryInfoSynced(true, true, 0)).toBe(false);
  });

  test('does not mark the final chunk while failures remain', () => {
    expect(shouldMarkEntryInfoSynced(true, false, 3)).toBe(false);
  });

  test('does not mark a mid-chunk that also has failures', () => {
    expect(shouldMarkEntryInfoSynced(true, true, 1)).toBe(false);
  });

  test('does not let a targeted API or retry job complete the daily scan', () => {
    expect(shouldMarkEntryInfoSynced(false, false, 0)).toBe(false);
  });
});
