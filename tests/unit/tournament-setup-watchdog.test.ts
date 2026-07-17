import { beforeEach, describe, expect, mock, test } from 'bun:test';

const findStuckProcessing = mock(async (): Promise<Array<Record<string, unknown>>> => []);
const markSetupResult = mock(async () => {});
mock.module('../../src/repositories/tournament-infos', () => ({
  tournamentInfoRepository: { findStuckProcessing, markSetupResult },
}));

const enqueueTournamentSetup = mock(async () => ({ id: 'setup-job-1' }));
const getTournamentSetupJobState = mock(
  async (): Promise<{ jobId: string; state: string } | null> => null,
);
mock.module('../../src/jobs/tournament-setup.jobs', () => ({
  enqueueTournamentSetup,
  getTournamentSetupJobState,
}));

const { recoverStuckTournamentSetups } = await import(
  '../../src/services/tournament-setup.service'
);

const stuckRow = {
  id: 777,
  setupStartedAt: new Date('2026-07-17T00:00:00Z'),
};

describe('recoverStuckTournamentSetups', () => {
  beforeEach(() => {
    findStuckProcessing.mockClear();
    markSetupResult.mockClear();
    enqueueTournamentSetup.mockClear();
    getTournamentSetupJobState.mockClear();
    findStuckProcessing.mockImplementation(async () => [stuckRow]);
  });

  test('recovers a stuck setup when no BullMQ job exists', async () => {
    getTournamentSetupJobState.mockImplementation(async () => null);

    const result = await recoverStuckTournamentSetups(60);

    expect(result.recovered).toEqual([777]);
    expect(markSetupResult).toHaveBeenCalledWith(777, 'failed', expect.stringContaining('stuck'));
    expect(enqueueTournamentSetup).toHaveBeenCalledWith(777, 'watchdog', { forceNew: true });
  });

  test('recovers when the canonical job already settled', async () => {
    getTournamentSetupJobState.mockImplementation(async () => ({
      jobId: 'tournament-setup-777',
      state: 'failed',
    }));

    const result = await recoverStuckTournamentSetups(60);

    expect(result.recovered).toEqual([777]);
    expect(enqueueTournamentSetup).toHaveBeenCalledTimes(1);
  });

  test('skips recovery while a job is active — slow is not stuck', async () => {
    getTournamentSetupJobState.mockImplementation(async () => ({
      jobId: 'tournament-setup-777',
      state: 'active',
    }));

    const result = await recoverStuckTournamentSetups(60);

    expect(result.recovered).toEqual([]);
    expect(markSetupResult).not.toHaveBeenCalled();
    expect(enqueueTournamentSetup).not.toHaveBeenCalled();
  });

  test('skips recovery while a job is still waiting or delayed', async () => {
    for (const state of ['waiting', 'delayed', 'prioritized']) {
      getTournamentSetupJobState.mockImplementation(async () => ({
        jobId: 'tournament-setup-777',
        state,
      }));

      const result = await recoverStuckTournamentSetups(60);

      expect(result.recovered).toEqual([]);
    }
    expect(enqueueTournamentSetup).not.toHaveBeenCalled();
  });

  test('returns empty when nothing is stuck', async () => {
    findStuckProcessing.mockImplementation(async () => []);

    const result = await recoverStuckTournamentSetups(60);

    expect(result.recovered).toEqual([]);
    expect(getTournamentSetupJobState).not.toHaveBeenCalled();
  });
});
