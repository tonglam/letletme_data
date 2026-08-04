import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { afterEach, describe, expect, test } from 'bun:test';

import {
  cancelWaitingTournamentSetupJobs,
  enqueueTournamentSetup,
  getTournamentSetupJobIds,
} from '../../src/jobs/tournament-setup.jobs';

describe('tournament setup enqueue serialization', () => {
  const tournamentId = 980_000 + (Date.now() % 10_000);

  afterEach(async () => {
    await cancelWaitingTournamentSetupJobs(tournamentId);
  });

  test('serializes prepare and deterministic add for concurrent retries', async () => {
    let activePreparations = 0;
    let maxActivePreparations = 0;
    let preparationCount = 0;
    const prepareEnqueue = async () => {
      activePreparations += 1;
      maxActivePreparations = Math.max(maxActivePreparations, activePreparations);
      await Bun.sleep(30);
      preparationCount += 1;
      activePreparations -= 1;
    };

    const [first, second] = await Promise.all([
      enqueueTournamentSetup(tournamentId, 'manual', { forceNew: true, prepareEnqueue }),
      enqueueTournamentSetup(tournamentId, 'manual', { forceNew: true, prepareEnqueue }),
    ]);

    expect(first.id).toBe(getTournamentSetupJobIds(tournamentId).baseJobId);
    expect(String(second.id)).toBe(String(first.id));
    expect(preparationCount).toBe(2);
    expect(maxActivePreparations).toBe(1);
  });
});
