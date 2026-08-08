import { describe, expect, test } from 'bun:test';

import { findMissingTournamentPickEntryIds } from '../../src/services/tournament-event-picks.service';
import {
  findFreshTournamentResultEntryIds,
  planTournamentEventSync,
} from '../../src/services/tournament-event-results.service';
import { isTournamentTransferCheckpointEvent } from '../../src/services/tournament-event-transfers.service';
import { isFreshnessBoundaryNewer, latestFreshnessTimestamp } from '../../src/domain/freshness';

describe('tournament sync convergence planning', () => {
  test('returns exact missing pick IDs', () => {
    expect(findMissingTournamentPickEntryIds([11, 12, 13, 14], new Set([11, 13]))).toEqual([
      12, 14,
    ]);
  });

  test('treats only rows at or after the attempt boundary as fresh', () => {
    const cutoff = new Date('2026-08-04T10:00:00.000Z');
    const rows = [
      {
        entryId: 1,
        richSyncedAt: new Date('2026-08-04T09:59:59.999Z'),
        updatedAt: new Date('2026-08-04T10:00:00.500Z'),
      },
      { entryId: 2, richSyncedAt: cutoff, updatedAt: cutoff },
      {
        entryId: 3,
        richSyncedAt: new Date('2026-08-04T10:00:00.001Z'),
        updatedAt: new Date('2026-08-04T10:00:00.001Z'),
      },
      { entryId: 4, richSyncedAt: null, updatedAt: new Date('2026-08-04T10:00:01Z') },
    ];
    expect(findFreshTournamentResultEntryIds(rows, cutoff)).toEqual(new Set([2, 3]));
  });

  test('raises a retry cutoff to the exact finalization boundary', () => {
    const retryCutoff = '2026-08-04T10:00:00.000100Z';
    const finalizationCutoff = '2026-08-04T10:00:00.000900Z';
    expect(latestFreshnessTimestamp(retryCutoff, finalizationCutoff)).toBe(finalizationCutoff);
  });

  test('detects a finalization boundary that advances during result work', () => {
    expect(
      isFreshnessBoundaryNewer('2026-08-04T10:00:00.000100Z', '2026-08-04T10:00:00.000900Z'),
    ).toBe(true);
    expect(
      isFreshnessBoundaryNewer('2026-08-04T10:00:00.000900Z', '2026-08-04T10:00:00.000100Z'),
    ).toBe(false);
    expect(isFreshnessBoundaryNewer('2026-08-04T10:00:00Z', null)).toBe(false);
  });

  test('cold, warm, and partial retries select only canonical gaps', () => {
    const entryIds = [1, 2, 3];

    expect(planTournamentEventSync(entryIds, new Set(), new Set(), new Set(entryIds))).toEqual({
      requiredResultEntryIds: entryIds,
      requiredTransferEntryIds: entryIds,
      reusedUnits: 0,
    });

    expect(
      planTournamentEventSync(entryIds, new Set(entryIds), new Set(entryIds), new Set()),
    ).toEqual({
      requiredResultEntryIds: [],
      requiredTransferEntryIds: [],
      reusedUnits: 6,
    });

    expect(
      planTournamentEventSync(entryIds, new Set([1, 2]), new Set([1, 3]), new Set([2])),
    ).toEqual({
      requiredResultEntryIds: [2, 3],
      requiredTransferEntryIds: [2],
      reusedUnits: 3,
    });
  });

  test('skip-transfers mode plans result work only', () => {
    expect(
      planTournamentEventSync([1, 2], new Set([1]), new Set([1, 2]), new Set([1, 2]), true),
    ).toEqual({
      requiredResultEntryIds: [2],
      requiredTransferEntryIds: [],
      reusedUnits: 1,
    });
  });

  test('includes GW1 in transfer checkpoint synchronization', () => {
    expect(isTournamentTransferCheckpointEvent(1)).toBe(true);
    expect(isTournamentTransferCheckpointEvent(38)).toBe(true);
    expect(isTournamentTransferCheckpointEvent(0)).toBe(false);
    expect(isTournamentTransferCheckpointEvent(39)).toBe(false);
    expect(isTournamentTransferCheckpointEvent(1.5)).toBe(false);
  });
});
