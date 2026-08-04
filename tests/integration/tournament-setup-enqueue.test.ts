import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { afterEach, describe, expect, test } from 'bun:test';

import {
  cancelWaitingTournamentSetupJobs,
  enqueueTournamentSetup,
  getTournamentSetupJobIds,
} from '../../src/jobs/tournament-setup.jobs';
import { getTournamentSetupJobPriority } from '../../src/domain/job-priority';
import { getTournamentSetupQueue } from '../../src/queues/tournament-setup.queue';

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

  test('reuses a deterministic job when its successful add response is lost', async () => {
    const queue = getTournamentSetupQueue(getTournamentSetupJobPriority('tournament-setup'));
    const originalAdd = queue.add;
    let injected = false;
    queue.add = (async (...args: Parameters<typeof originalAdd>) => {
      const added = await originalAdd.apply(queue, args);
      if (!injected) {
        injected = true;
        throw new Error('simulated lost queue add response');
      }
      return added;
    }) as typeof queue.add;

    try {
      const job = await enqueueTournamentSetup(tournamentId, 'resume', { forceNew: true });
      expect(injected).toBe(true);
      expect(job.id).toBe(getTournamentSetupJobIds(tournamentId).baseJobId);
      expect(await queue.getJob(getTournamentSetupJobIds(tournamentId).baseJobId)).not.toBeNull();
    } finally {
      queue.add = originalAdd;
    }
  });
});
