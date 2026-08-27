import { describe, expect, test } from 'bun:test';

import { validateEntryHistoryCoverage } from '../../src/services/entry-info.service';
import type { RawFPLEntryHistoryCurrentItem } from '../../src/types';

function history(...eventIds: number[]): RawFPLEntryHistoryCurrentItem[] {
  return eventIds.map((event) => ({
    event,
    points: 50,
    total_points: event * 50,
    event_transfers: 0,
    event_transfers_cost: 0,
  }));
}

describe('entry snapshot history coverage', () => {
  test('accepts preseason and every contiguous event since the entry started', () => {
    expect(() => validateEntryHistoryCoverage(1, 0, [])).not.toThrow();
    expect(() => validateEntryHistoryCoverage(3, 5, history(3, 4, 5))).not.toThrow();
    expect(() => validateEntryHistoryCoverage(2, 1, [])).not.toThrow();
    expect(() => validateEntryHistoryCoverage(10, 5, [])).not.toThrow();
  });

  test('rejects a truncated response instead of advancing the checkpoint', () => {
    expect(() => validateEntryHistoryCoverage(1, 5, history(1, 2, 4, 5))).toThrow('1 missing');
  });

  test('rejects invalid targets, duplicate events, and out-of-range events', () => {
    expect(() => validateEntryHistoryCoverage(1, 39, history(1))).toThrow(
      'event from 0 through 38',
    );
    expect(() => validateEntryHistoryCoverage(1, 2, history(1, 1, 2))).toThrow('duplicate');
    expect(() => validateEntryHistoryCoverage(1, 1, history(0, 1))).toThrow('invalid');
  });
});
