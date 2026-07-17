import { beforeEach, describe, expect, mock, test } from 'bun:test';

const findActive = mock(async (): Promise<Array<{ id: number }>> => []);
mock.module('../../src/repositories/tournament-infos', () => ({
  tournamentInfoRepository: { findActive },
}));

const enqueueLeagueEventPicks = mock(
  async (_eventId: number, _source?: string, _options?: { tournamentId?: number }) => ({
    id: 'picks-job',
  }),
);
const enqueueLeagueEventResults = mock(
  async (_eventId: number, _source?: string, _options?: { tournamentId?: number }) => ({
    id: 'results-job',
  }),
);
mock.module('../../src/jobs/league-sync.jobs', () => ({
  enqueueLeagueEventPicks,
  enqueueLeagueEventResults,
}));

const { enqueuePicksPerTournament, enqueueResultsPerTournament } = await import(
  '../../src/services/league-sync.service'
);

describe('league-sync fan-out', () => {
  beforeEach(() => {
    findActive.mockClear();
    enqueueLeagueEventPicks.mockClear();
    enqueueLeagueEventResults.mockClear();
  });

  test('returns the enqueued count when every tournament enqueue succeeds', async () => {
    findActive.mockImplementation(async () => [{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await enqueuePicksPerTournament(20);

    expect(result).toEqual({ enqueued: 3 });
    expect(enqueueLeagueEventPicks).toHaveBeenCalledTimes(3);
    expect(enqueueLeagueEventPicks).toHaveBeenCalledWith(20, 'cascade', { tournamentId: 2 });
  });

  test('throws when any picks enqueue fails so the coordinator retries', async () => {
    findActive.mockImplementation(async () => [{ id: 1 }, { id: 2 }, { id: 3 }]);
    enqueueLeagueEventPicks.mockImplementation(async (_eventId, _source, options) => {
      if (options?.tournamentId === 2) {
        throw new Error('redis down');
      }
      return { id: 'picks-job' };
    });

    await expect(enqueuePicksPerTournament(20)).rejects.toThrow(
      'League picks cascade enqueue failed for 1 of 3 tournaments',
    );
  });

  test('throws when any results enqueue fails so the coordinator retries', async () => {
    findActive.mockImplementation(async () => [{ id: 7 }]);
    enqueueLeagueEventResults.mockImplementation(async () => {
      throw new Error('redis down');
    });

    await expect(enqueueResultsPerTournament(20)).rejects.toThrow(
      'League results cascade enqueue failed for 1 of 1 tournaments',
    );
  });

  test('returns zero when no tournaments are active', async () => {
    findActive.mockImplementation(async () => []);

    expect(await enqueuePicksPerTournament(20)).toEqual({ enqueued: 0 });
    expect(await enqueueResultsPerTournament(20)).toEqual({ enqueued: 0 });
  });
});
