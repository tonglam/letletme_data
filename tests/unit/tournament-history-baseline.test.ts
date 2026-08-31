import { describe, expect, test } from 'bun:test';

import {
  buildCoreHistoryConflictSet,
  buildCoreHistoryUpsertPlan,
  chunkCoreHistoryRows,
} from '../../src/repositories/entry-event-results-history';
import type { RawFPLEntryHistoryCurrentItem } from '../../src/types';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

describe('tournament history baseline upsert', () => {
  test('batches core fields, computes net points, and routes missing costs to picks fallback', async () => {
    const complete: RawFPLEntryHistoryCurrentItem[] = Array.from({ length: 251 }, (_, index) => ({
      event: index + 1,
      points: 70,
      total_points: 1000 + index,
      rank: 50 + index,
      overall_rank: 500 + index,
      bank: 15,
      value: 1034,
      event_transfers: 2,
      event_transfers_cost: 4,
      points_on_bench: 9,
    }));
    const missingTransferCost: RawFPLEntryHistoryCurrentItem = {
      event: 252,
      points: 60,
      total_points: 1300,
      event_transfers: 1,
    };

    const result = buildCoreHistoryUpsertPlan(TEST_SEASON, 123, [...complete, missingTransferCost]);
    const batches = chunkCoreHistoryRows(result.rows);

    expect(batches.map((batch) => batch.length)).toEqual([250, 1]);
    expect(batches[0][0]).toMatchObject({
      entryId: 123,
      eventId: 1,
      eventPoints: 70,
      eventTransfers: 2,
      eventTransfersCost: 4,
      eventNetPoints: 66,
      eventBenchPoints: 9,
      teamValue: 1034,
      bank: 15,
    });
    expect(result.upsertedEventIds).toHaveLength(251);
    expect(result.fallbackEventIds).toEqual([252]);

    const conflictSet = buildCoreHistoryConflictSet();
    expect(conflictSet).not.toHaveProperty('eventPicks');
    expect(conflictSet).not.toHaveProperty('eventPlayedCaptain');
    expect(conflictSet).not.toHaveProperty('eventChip');
    expect(conflictSet).not.toHaveProperty('eventAutoSub');
    expect(conflictSet.updatedAt).toBeDefined();
    const updatedAtChunks = (
      conflictSet.updatedAt as unknown as {
        queryChunks?: Array<{ value?: string[] }>;
      }
    ).queryChunks;
    expect(
      updatedAtChunks?.some((chunk) =>
        chunk.value?.some((value) => value.includes('clock_timestamp()')),
      ),
    ).toBe(true);
  });
});
