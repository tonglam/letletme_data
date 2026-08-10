import { describe, expect, it } from 'bun:test';

import { buildTransferReplacementRows } from '../../src/repositories/entry-event-transfers';
import type { RawFPLEntryTransfer } from '../../src/types';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

/**
 * FP-10 (H5, H6): upsert correctness.
 * A repeated transfer refresh must never null out computed enrichment.
 * Player values are now derived from canonical market snapshots and have no
 * second writable repository to test here.
 */

const TRANSFER: RawFPLEntryTransfer = {
  element_in: 100,
  element_in_cost: 55,
  element_out: 200,
  element_out_cost: 60,
  entry: 12345,
  event: 10,
  time: '2026-07-17T10:00:00Z',
};

describe('entry-event-transfers upsert (H5)', () => {
  it('keeps computed fields when an identical transfer is refreshed without them', () => {
    const rows = buildTransferReplacementRows({
      season: TEST_SEASON,
      entryId: 12345,
      eventId: 10,
      transfers: [TRANSFER],
      existing: [
        {
          id: 1,
          seasonId: TEST_SEASON.seasonId,
          transferId: 1,
          entryId: 12345,
          eventId: 10,
          elementInId: 100,
          elementInCost: 55,
          elementInPoints: 8,
          elementInPlayed: true,
          elementOutId: 200,
          elementOutCost: 60,
          elementOutPoints: 2,
          transferTime: new Date(TRANSFER.time),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.elementInPlayed).toBe(true);
    expect(rows[0]?.elementInPoints).toBe(8);
    expect(rows[0]?.elementOutPoints).toBe(2);
  });

  it('plans the complete ordered transfer history', () => {
    const rows = buildTransferReplacementRows({
      season: TEST_SEASON,
      entryId: 12345,
      eventId: 10,
      transfers: [
        { ...TRANSFER, event: 9, time: '2026-07-10T10:00:00Z' },
        TRANSFER,
        { ...TRANSFER, element_in: 101, element_out: 201, time: '2026-07-17T11:00:00Z' },
      ],
      existing: [],
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.eventId)).toEqual([9, 10, 10]);
    expect(rows.map((row) => row.elementInId)).toEqual([100, 100, 101]);
  });
});
