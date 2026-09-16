import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';
import type { TournamentConfig } from '../../src/domain/tournament';
import { entryInfoRepository } from '../../src/repositories/entry-infos';
import * as resultRepositories from '../../src/repositories/entry-event-results';
import * as transferRepositories from '../../src/repositories/entry-event-transfers';
import { entryEventResultsRepository } from '../../src/repositories/entry-event-results';
import { entryEventPicksRepository } from '../../src/repositories/entry-event-picks';
import { entryEventTransfersRepository } from '../../src/repositories/entry-event-transfers';
import { eventRepository } from '../../src/repositories/events';
import * as entries from '../../src/services/entries.service';
import * as eventResults from '../../src/services/tournament-event-results.service';
import * as mutationScopes from '../../src/utils/mutation-scopes';
import * as pointsResults from '../../src/services/tournament-points-race-results.service';
import * as leagueResults from '../../src/services/league-event-results.service';
import { runTournamentEventBackfill } from '../../src/services/tournament-backfill.service';
import { buildBattleMatchupSchedule } from '../../src/services/tournament-structure.service';

const ids = Array.from({ length: 1567 }, (_, i) => i + 1);
const cutoff = '2026-09-01T10:00:00.123456Z';
const tournament = {
  id: 4,
  groupMode: 'no_group',
  knockoutMode: 'no_knockout',
} as TournamentConfig;
let complete: Set<number>;

beforeEach(() => {
  complete = new Set(ids);
  spyOn(entryInfoRepository, 'findByIds').mockResolvedValue(
    ids.map((id) => ({ id, startedEvent: 1 })) as never,
  );
  spyOn(eventRepository, 'findById').mockResolvedValue({
    finished: true,
    dataChecked: true,
    dataCheckedAt: new Date(cutoff),
  } as never);
  spyOn(eventRepository, 'findDataCheckedAtExact').mockResolvedValue(cutoff);
  spyOn(entryEventResultsRepository, 'findByEventAndEntryIds').mockResolvedValue(
    ids.map((entryId) => ({ entryId, eventPicks: [{}] })) as never,
  );
  spyOn(entryEventPicksRepository, 'findHeadsByEventAndEntryIds').mockResolvedValue([]);
  spyOn(entries, 'completedFinalEntryIds').mockImplementation(async () => new Set(complete));
  spyOn(entryEventTransfersRepository, 'findEntryIdsNeedingSync').mockResolvedValue([]);
  spyOn(eventResults, 'syncTournamentEventResultsForEntryIds').mockImplementation(
    async (_s, needed) => {
      needed.forEach((id) => complete.add(id));
      return {
        eventId: 3,
        totalEntries: needed.length,
        synced: needed.length,
        errors: 0,
        requiredUnits: needed.length,
        reusedUnits: 0,
        succeededUnits: needed.length,
        failedUnits: 0,
      };
    },
  );
  spyOn(eventResults, 'syncEntryTransferHistories').mockResolvedValue({
    synced: 1,
    errors: 0,
    failedEntryIds: [],
    requiredUnits: 1,
    reusedUnits: 0,
    reusedEntryIds: [],
    succeededUnits: 1,
    failedUnits: 0,
  });
  spyOn(leagueResults, 'syncLeagueEventResultsByTournament').mockResolvedValue({
    totalEntries: ids.length,
    updated: ids.length,
    skipped: 0,
    requiredUnits: ids.length,
    reusedUnits: 0,
    succeededUnits: ids.length,
    failedUnits: 0,
  } as never);
});
afterEach(() => mock.restore());

const run = () => runTournamentEventBackfill(TEST_SEASON, 4, tournament, ids, 3);

describe('rebuilt battle schedule', () => {
  test('derives the complete round whitelist independently of persisted result rows', () => {
    const keys = buildBattleMatchupSchedule(
      [1, 2, 3, 4].map((groupIndex) => ({
        groupId: 1,
        groupIndex,
        startedEventId: 1,
        endedEventId: 3,
      })),
    );
    const eventOnePairs = keys
      .filter((key) => key.eventId === 1)
      .map((key) => [key.homeIndex, key.awayIndex].sort((left, right) => left - right).join('-'));
    expect(new Set(eventOnePairs)).toEqual(new Set(['1-4', '2-3']));
    expect(keys).not.toContainEqual({
      groupId: 1,
      eventId: 1,
      homeIndex: 4,
      awayIndex: 1,
    });
    expect(keys).not.toContainEqual({
      groupId: 1,
      eventId: 1,
      homeIndex: 1,
      awayIndex: 3,
    });
    expect(keys).toContainEqual({
      groupId: 1,
      eventId: 2,
      homeIndex: 1,
      awayIndex: 2,
    });
  });
});

describe('FINAL tournament repair convergence', () => {
  test('reuses 1567 completed FINAL inputs without repeating provider synchronization', async () => {
    expect(await run()).toEqual([]);
    expect(eventResults.syncTournamentEventResultsForEntryIds).not.toHaveBeenCalled();
    expect(eventResults.syncEntryTransferHistories).not.toHaveBeenCalled();
    expect(leagueResults.syncLeagueEventResultsByTournament).toHaveBeenCalledWith(
      TEST_SEASON,
      4,
      3,
      expect.objectContaining({ freshAfter: cutoff, rebuildFromCurrentInputs: true }),
    );
  });
  test('accepts fully reused or concurrently completed league units without new writes', async () => {
    for (const reusedUnits of [ids.length, 0]) {
      spyOn(leagueResults, 'syncLeagueEventResultsByTournament').mockResolvedValue({
        tournamentId: 4,
        eventId: 3,
        totalEntries: ids.length,
        updated: 0,
        skipped: 0,
        errors: 0,
        requiredUnits: ids.length - reusedUnits,
        reusedUnits,
        succeededUnits: ids.length - reusedUnits,
        failedUnits: 0,
      });
      expect(await run()).toEqual([]);
    }
  });
  test('retries only missing FINAL inputs and allows durable recovery first', async () => {
    complete.delete(7);
    await run();
    expect(eventResults.syncTournamentEventResultsForEntryIds).toHaveBeenCalledWith(
      TEST_SEASON,
      [7],
      3,
      expect.objectContaining({ skipTransfers: true, finalizationRecoveryEntryIds: new Set([7]) }),
    );
    await run();
    expect(eventResults.syncTournamentEventResultsForEntryIds).toHaveBeenCalledTimes(1);
  });
  test('does not calculate standings after incomplete FINAL recovery', async () => {
    complete.delete(7);
    spyOn(eventResults, 'syncTournamentEventResultsForEntryIds').mockRejectedValue(
      new Error('FINAL missing'),
    );
    await expect(run()).rejects.toThrow('FINAL missing');
    expect(leagueResults.syncLeagueEventResultsByTournament).not.toHaveBeenCalled();
  });
  test('fetches only missing transfers and preserves transfer failure', async () => {
    spyOn(entryEventTransfersRepository, 'findEntryIdsNeedingSync').mockResolvedValue([9]);
    spyOn(eventResults, 'syncEntryTransferHistories').mockResolvedValue({
      synced: 0,
      errors: 1,
      failedEntryIds: [9],
      requiredUnits: 1,
      reusedUnits: 0,
      reusedEntryIds: [],
      succeededUnits: 0,
      failedUnits: 1,
    });
    await expect(run()).rejects.toThrow('transfer inputs remain incomplete');
    expect(eventResults.syncEntryTransferHistories).toHaveBeenCalledWith(
      TEST_SEASON,
      [9],
      3,
      expect.anything(),
    );
    expect(leagueResults.syncLeagueEventResultsByTournament).not.toHaveBeenCalled();
  });
  test('does not fetch transfers for managers who joined after the repaired round', async () => {
    spyOn(entryInfoRepository, 'findByIds').mockResolvedValue(
      ids.map((id) => ({ id, startedEvent: id === 9 ? 4 : 1 })) as never,
    );
    spyOn(transferRepositories, 'withEntrySeasonSyncTransaction').mockImplementation(
      async (_season, _entryId, operation) => operation({} as never),
    );
    spyOn(resultRepositories, 'createEntryEventResultsRepository').mockReturnValue({
      seedPreEntryBaselines: async () => 1,
    } as never);
    await run();
    expect(entryEventTransfersRepository.findEntryIdsNeedingSync).toHaveBeenCalledWith(
      TEST_SEASON,
      ids.filter((id) => id !== 9),
      3,
    );
    expect(eventResults.syncEntryTransferHistories).not.toHaveBeenCalled();
  });
  test('rejects a changed finalization boundary before deriving results', async () => {
    spyOn(eventRepository, 'findDataCheckedAtExact')
      .mockResolvedValueOnce(cutoff)
      .mockResolvedValue('2026-09-02T10:00:00.123456Z');
    await expect(run()).rejects.toThrow('finalization changed');
    expect(leagueResults.syncLeagueEventResultsByTournament).not.toHaveBeenCalled();
  });
  test('rejects a finalization correction made during league calculation', async () => {
    spyOn(leagueResults, 'syncLeagueEventResultsByTournament').mockImplementation(async () => {
      spyOn(eventRepository, 'findDataCheckedAtExact').mockResolvedValue(
        '2026-09-02T10:00:00.123456Z',
      );
      return {
        totalEntries: ids.length,
        updated: 0,
        skipped: 0,
        reusedUnits: ids.length,
        succeededUnits: 0,
        failedUnits: 0,
      } as never;
    });
    await expect(run()).rejects.toThrow('finalization changed during league');
  });
  test('fences the expected cutoff inside the short standings transaction', async () => {
    const writer = spyOn(pointsResults, 'syncTournamentPointsRaceResultsForTournament');
    spyOn(mutationScopes, 'withMutationScopes').mockImplementation(async (_request, operation) => {
      spyOn(eventRepository, 'findDataCheckedAtExact').mockResolvedValue(
        '2026-09-02T10:00:00.123456Z',
      );
      return operation();
    });
    await expect(
      runTournamentEventBackfill(
        TEST_SEASON,
        4,
        {
          ...tournament,
          groupMode: 'points_races',
          groupStartedEventId: 1,
          groupEndedEventId: 4,
        },
        ids,
        3,
      ),
    ).rejects.toThrow('finalization changed before standings');
    expect(writer).not.toHaveBeenCalled();
    expect(eventRepository.findDataCheckedAtExact).toHaveBeenLastCalledWith(TEST_SEASON, 3, {
      lock: 'share',
    });
  });
  test('does not accept failed provisional inputs even when older derived rows exist', async () => {
    spyOn(eventRepository, 'findById').mockResolvedValue({
      finished: false,
      dataChecked: false,
    } as never);
    spyOn(eventResults, 'syncTournamentEventResultsForEntryIds').mockResolvedValue({
      eventId: 3,
      totalEntries: ids.length,
      synced: ids.length - 1,
      errors: 1,
      requiredUnits: ids.length,
      reusedUnits: 0,
      succeededUnits: ids.length - 1,
      failedUnits: 1,
    });
    await expect(run()).rejects.toThrow('provisional inputs remain incomplete');
    expect(leagueResults.syncLeagueEventResultsByTournament).not.toHaveBeenCalled();
  });
  test('keeps provisional rounds on the fresh observation path', async () => {
    spyOn(eventRepository, 'findById').mockResolvedValue({
      finished: false,
      dataChecked: false,
    } as never);
    await run();
    expect(eventResults.syncTournamentEventResultsForEntryIds).toHaveBeenCalledWith(
      TEST_SEASON,
      ids,
      3,
      expect.anything(),
    );
  });
});
