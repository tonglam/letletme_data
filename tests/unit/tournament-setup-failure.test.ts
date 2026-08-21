import { describe, expect, test } from 'bun:test';

import { explicitSeasonRef } from '../../src/domain/fpl-season';
import type { TournamentSetupJobData } from '../../src/queues/tournament-setup.queue';
import type {
  EscapedSetupFailureDependencies,
  FailedTournamentSetupJob,
} from '../../src/services/tournament-setup-failure.service';
import { persistEscapedTournamentSetupFailure } from '../../src/services/tournament-setup-failure.service';

const season = explicitSeasonRef('2627');
const data: TournamentSetupJobData = {
  seasonId: season.seasonId,
  seasonCode: season.seasonCode,
  tournamentId: 8,
  source: 'create',
  triggeredAt: '2026-08-22T18:00:00.000Z',
};

function failedJob(attemptsMade: number): FailedTournamentSetupJob {
  return {
    id: 'tournament-setup-2627-8',
    name: 'tournament-setup',
    queueName: 'tournament-setup',
    data,
    attemptsMade,
    opts: { attempts: 3 },
    processedOn: Date.parse('2026-08-22T18:00:01.000Z'),
  };
}

function dependencies(
  status: Partial<Awaited<ReturnType<EscapedSetupFailureDependencies['findStatus']>>> = {},
) {
  const failures: Parameters<EscapedSetupFailureDependencies['persistFailure']>[2][] = [];
  const deps: EscapedSetupFailureDependencies = {
    requireSeason: async () => season,
    findStatus: async () => ({
      createdAt: '2026-08-22T18:00:00.000Z',
      setupStatus: 'pending',
      setupError: null,
      setupPhase: 'queued',
      setupCompletedUnits: 0,
      setupTotalUnits: 0,
      setupProgressUpdatedAt: null,
      standingsReadyAt: null,
      setupWarningCount: 0,
      setupStartedAt: null,
      setupFinishedAt: null,
      setupAttempt: 0,
      setupMaxAttempts: 3,
      setupNextRetryAt: null,
      setupLastErrorCode: null,
      setupLastErrorAt: null,
      setupProgressIndeterminate: false,
      profilesReadyAt: null,
      insightsReadyAt: null,
      ...status,
    }),
    persistFailure: async (_season, _job, failure) => {
      failures.push(failure);
      return true;
    },
    now: () => new Date('2026-08-22T18:00:02.000Z'),
  };
  return { deps, failures };
}

describe('tournament setup escaped failure fallback', () => {
  test('persists a retryable first attempt in a fresh fallback path', async () => {
    const { deps, failures } = dependencies();

    expect(await persistEscapedTournamentSetupFailure(failedJob(1), { code: '42846' }, deps)).toBe(
      true,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      attempt: 1,
      terminal: false,
      errorCode: '42846',
      startedAt: new Date('2026-08-22T18:00:01.000Z'),
    });
    expect(failures[0]?.nextRetryAt).toEqual(new Date('2026-08-22T18:01:02.000Z'));
  });

  test('uses the durable attempt counter and marks the final attempt terminal', async () => {
    const { deps, failures } = dependencies({ setupStatus: 'processing', setupAttempt: 2 });

    await persistEscapedTournamentSetupFailure(failedJob(1), new Error('commit failed'), deps);

    expect(failures[0]).toMatchObject({
      attempt: 3,
      terminal: true,
      errorCode: 'Error',
      nextRetryAt: null,
    });
  });

  test('does not overwrite a setup that already became ready', async () => {
    const { deps, failures } = dependencies({
      setupStatus: 'ready',
      setupPhase: 'ready',
      setupAttempt: 1,
      setupFinishedAt: '2026-08-22T18:00:02.000Z',
    });

    expect(await persistEscapedTournamentSetupFailure(failedJob(3), new Error('late'), deps)).toBe(
      false,
    );
    expect(failures).toHaveLength(0);
  });
});
