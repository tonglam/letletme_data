import { describe, expect, test } from 'bun:test';

import { formatOperationalTimestamp } from '../../src/api/live-status.api';

describe('live operational status timestamps', () => {
  test('normalizes Date and string values without assuming the driver runtime type', () => {
    expect(formatOperationalTimestamp(new Date('2026-08-27T00:00:00.000Z'))).toBe(
      '2026-08-27T00:00:00.000Z',
    );
    expect(formatOperationalTimestamp('2026-08-27T00:00:01.000Z')).toBe('2026-08-27T00:00:01.000Z');
  });

  test('returns null for absent or invalid values', () => {
    expect(formatOperationalTimestamp(null)).toBeNull();
    expect(formatOperationalTimestamp(undefined)).toBeNull();
    expect(formatOperationalTimestamp('not-a-timestamp')).toBeNull();
    expect(formatOperationalTimestamp(123)).toBeNull();
  });
});
