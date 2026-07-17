import { afterAll, describe, expect, mock, test } from 'bun:test';

import { entryEventResultsRepository } from '../../src/repositories/entry-event-results';
import { tournamentBattleGroupResultsRepository } from '../../src/repositories/tournament-battle-group-results';
import { tournamentEntryRepository } from '../../src/repositories/tournament-entries';
import { tournamentGroupRepository } from '../../src/repositories/tournament-groups';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentBattleRaceResults } from '../../src/services/tournament-battle-race-results.service';

// Direct method mutation + restore: bun's mock.module overwrites exports of
// already-loaded modules globally, leaking into other test files.
const originals = {
  findBattleRaceByEvent: tournamentInfoRepository.findBattleRaceByEvent,
  findEntryIdsByTournamentId: tournamentEntryRepository.findEntryIdsByTournamentId,
  findByEventAndEntryIds: entryEventResultsRepository.findByEventAndEntryIds,
  aggregateTotalsByEntry: entryEventResultsRepository.aggregateTotalsByEntry,
  battleFindByTournamentAndEvent: tournamentBattleGroupResultsRepository.findByTournamentAndEvent,
  battleUpsertBatch: tournamentBattleGroupResultsRepository.upsertBatch,
  groupFindByTournamentAndEntries: tournamentGroupRepository.findByTournamentAndEntries,
  groupFindByTournamentAndGroup: tournamentGroupRepository.findByTournamentAndGroup,
  groupUpsertBatch: tournamentGroupRepository.upsertBatch,
};

afterAll(() => {
  tournamentInfoRepository.findBattleRaceByEvent = originals.findBattleRaceByEvent;
  tournamentEntryRepository.findEntryIdsByTournamentId = originals.findEntryIdsByTournamentId;
  entryEventResultsRepository.findByEventAndEntryIds = originals.findByEventAndEntryIds;
  entryEventResultsRepository.aggregateTotalsByEntry = originals.aggregateTotalsByEntry;
  tournamentBattleGroupResultsRepository.findByTournamentAndEvent =
    originals.battleFindByTournamentAndEvent;
  tournamentBattleGroupResultsRepository.upsertBatch = originals.battleUpsertBatch;
  tournamentGroupRepository.findByTournamentAndEntries = originals.groupFindByTournamentAndEntries;
  tournamentGroupRepository.findByTournamentAndGroup = originals.groupFindByTournamentAndGroup;
  tournamentGroupRepository.upsertBatch = originals.groupUpsertBatch;
});

function makeGroupRow(overrides: Record<string, unknown>) {
  return {
    tournamentId: 7,
    groupName: 'Group A',
    groupIndex: 0,
    startedEventId: 1,
    endedEventId: 38,
    groupPoints: 0,
    groupRank: 0,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    qualified: 0,
    createdAt: new Date('2025-08-01T00:00:00Z'),
    ...overrides,
  };
}

describe('battle race results batching', () => {
  test('loads all group rows in one query and buckets them by groupId', async () => {
    const entryIds = [101, 102, 103, 104];

    tournamentInfoRepository.findBattleRaceByEvent = mock(async () => [
      { id: 7, groupStartedEventId: 1, groupEndedEventId: 38, groupQualifyNum: 2 },
    ]) as never;
    tournamentEntryRepository.findEntryIdsByTournamentId = mock(async () => entryIds) as never;
    entryEventResultsRepository.findByEventAndEntryIds = mock(async () => [
      { entryId: 101, eventNetPoints: 10, eventRank: 100, overallRank: 1000 },
      { entryId: 102, eventNetPoints: 5, eventRank: 200, overallRank: 2000 },
      { entryId: 103, eventNetPoints: 7, eventRank: 150, overallRank: 1500 },
      { entryId: 104, eventNetPoints: 7, eventRank: 160, overallRank: 1600 },
    ]) as never;
    entryEventResultsRepository.aggregateTotalsByEntry = mock(async () => [
      { entryId: 101, totalPoints: 10, totalTransfersCost: 0, totalNetPoints: 10 },
      { entryId: 102, totalPoints: 5, totalTransfersCost: 0, totalNetPoints: 5 },
      { entryId: 103, totalPoints: 7, totalTransfersCost: 0, totalNetPoints: 7 },
      { entryId: 104, totalPoints: 7, totalTransfersCost: 0, totalNetPoints: 7 },
    ]) as never;
    tournamentBattleGroupResultsRepository.findByTournamentAndEvent = mock(async () => [
      { id: 501, tournamentId: 7, eventId: 1, groupId: 1, homeEntryId: 101, awayEntryId: 102 },
      { id: 502, tournamentId: 7, eventId: 1, groupId: 2, homeEntryId: 103, awayEntryId: 104 },
    ]) as never;

    const findByEntries = mock(async (_tournamentId: number, _entryIds: number[]) => [
      makeGroupRow({ id: 1, groupId: 1, entryId: 101 }),
      makeGroupRow({ id: 2, groupId: 1, entryId: 102 }),
      makeGroupRow({ id: 3, groupId: 2, entryId: 103 }),
      makeGroupRow({ id: 4, groupId: 2, entryId: 104 }),
    ]);
    const findByGroup = mock(async () => []);
    tournamentGroupRepository.findByTournamentAndEntries = findByEntries as never;
    tournamentGroupRepository.findByTournamentAndGroup = findByGroup as never;

    const upsertedGroups: Array<Array<Record<string, unknown>>> = [];
    tournamentGroupRepository.upsertBatch = mock(async (rows: Array<Record<string, unknown>>) => {
      upsertedGroups.push(rows);
      return rows.length;
    }) as never;
    const upsertedResults: Array<Array<Record<string, unknown>>> = [];
    tournamentBattleGroupResultsRepository.upsertBatch = mock(
      async (rows: Array<Record<string, unknown>>) => {
        upsertedResults.push(rows);
        return rows.length;
      },
    ) as never;

    const result = await syncTournamentBattleRaceResults(1);

    // One batched query for every group row; the per-group query is gone.
    expect(findByEntries).toHaveBeenCalledTimes(1);
    expect(findByEntries.mock.calls[0][0]).toBe(7);
    expect(findByEntries.mock.calls[0][1]).toEqual(entryIds);
    expect(findByGroup).not.toHaveBeenCalled();

    expect(result).toEqual({ eventId: 1, updatedGroups: 4, updatedResults: 2, skipped: 0 });

    const groupsByEntry = new Map(upsertedGroups[0].map((row) => [row.entryId, row]));
    expect(groupsByEntry.get(101)).toMatchObject({
      groupPoints: 3,
      played: 1,
      won: 1,
      lost: 0,
      groupRank: 1,
      qualified: 1,
      totalNetPoints: 10,
    });
    expect(groupsByEntry.get(102)).toMatchObject({
      groupPoints: 0,
      played: 1,
      lost: 1,
      groupRank: 2,
      qualified: 1,
    });
    // Drawn match: both entries get 1 point; rank tie broken by overall rank.
    expect(groupsByEntry.get(103)).toMatchObject({ groupPoints: 1, drawn: 1, groupRank: 1 });
    expect(groupsByEntry.get(104)).toMatchObject({ groupPoints: 1, drawn: 1, groupRank: 2 });

    expect(upsertedResults[0][0]).toMatchObject({
      homeNetPoints: 10,
      awayNetPoints: 5,
      homeMatchPoints: 3,
      awayMatchPoints: 0,
    });
    expect(upsertedResults[0][1]).toMatchObject({ homeMatchPoints: 1, awayMatchPoints: 1 });
  });
});
