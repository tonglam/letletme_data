import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';
import type { TournamentConfig } from '../../src/domain/tournament';
import { entryInfoRepository } from '../../src/repositories/entry-infos';
import { entryEventResultsRepository } from '../../src/repositories/entry-event-results';
import { entryEventPicksRepository } from '../../src/repositories/entry-event-picks';
import { entryEventTransfersRepository } from '../../src/repositories/entry-event-transfers';
import { eventRepository } from '../../src/repositories/events';
import * as entries from '../../src/services/entries.service';
import * as eventResults from '../../src/services/tournament-event-results.service';
import * as leagueResults from '../../src/services/league-event-results.service';
import { runTournamentEventBackfill } from '../../src/services/tournament-backfill.service';

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
    succeededUnits: 1,
    failedUnits: 0,
  });
  spyOn(leagueResults, 'syncLeagueEventResultsByTournament').mockResolvedValue({
    totalEntries: ids.length,
    updated: ids.length,
    skipped: 0,
  } as never);
});
afterEach(() => mock.restore());

const run = () => runTournamentEventBackfill(TEST_SEASON, 4, tournament, ids, 3);

describe('FINAL tournament repair convergence', () => {
  test('reuses 1567 completed FINAL inputs without repeating provider synchronization', async () => {
    expect(await run()).toEqual([]);
    expect(eventResults.syncTournamentEventResultsForEntryIds).not.toHaveBeenCalled();
    expect(eventResults.syncEntryTransferHistories).not.toHaveBeenCalled();
    expect(leagueResults.syncLeagueEventResultsByTournament).toHaveBeenCalledTimes(1);
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
  test('rejects a changed finalization boundary before deriving results', async () => {
    spyOn(eventRepository, 'findDataCheckedAtExact')
      .mockResolvedValueOnce(cutoff)
      .mockResolvedValue('2026-09-02T10:00:00.123456Z');
    await expect(run()).rejects.toThrow('finalization changed');
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
