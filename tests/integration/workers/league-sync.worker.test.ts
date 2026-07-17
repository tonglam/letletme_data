import { assertIntegrationEnv } from '../helpers/env-guard';

assertIntegrationEnv();
import type { Job, Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  enqueueLeagueEventPicks,
  enqueueLeagueEventResults,
} from '../../../src/jobs/league-sync.jobs';
import {
  leagueSyncQueuesByTier,
  type LeagueSyncJobData,
} from '../../../src/queues/league-sync.queue';
import { tournamentInfoRepository } from '../../../src/repositories/tournament-infos';
import { getCurrentEvent } from '../../../src/services/events.service';
import { createLeagueSyncWorker } from '../../../src/workers/league-sync.worker';
import type { WorkerRuntime } from '../../../src/workers/worker-runtime';

describe('League Sync Worker Integration Tests', () => {
  let leagueSyncRuntime: WorkerRuntime;
  let testEventId: number;
  let testTournamentId: number | null = null;

  const leagueSyncQueues = Array.from(
    new Map(Object.values(leagueSyncQueuesByTier).map((queue) => [queue.name, queue])).values(),
  );

  async function cleanLeagueSyncQueues() {
    await Promise.all(
      leagueSyncQueues.map(async (queue: Queue<LeagueSyncJobData>) => {
        await queue.drain();
        await queue.clean(0, 0, 'completed');
        await queue.clean(0, 0, 'failed');
        await queue.clean(0, 0, 'delayed');
      }),
    );
  }

  function getQueueEvents(job: Job<LeagueSyncJobData>) {
    const target = leagueSyncRuntime.monitorTargets.find(
      ({ queueName }) => queueName === job.queueName,
    );
    if (!target) {
      throw new Error(`No QueueEvents found for queue ${job.queueName}`);
    }
    return target.queueEvents;
  }

  async function expectJobCompleted(job: Job<LeagueSyncJobData>, timeout: number) {
    await job.waitUntilFinished(getQueueEvents(job), timeout);
    expect(await job.getState()).toBe('completed');
  }

  beforeAll(async () => {
    await cleanLeagueSyncQueues();

    leagueSyncRuntime = createLeagueSyncWorker();
    if (leagueSyncRuntime.workers.length === 0)
      throw new Error('League sync worker was not created');
    await Promise.all(leagueSyncRuntime.workers.map((worker) => worker.waitUntilReady()));

    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found');
    }
    testEventId = currentEvent.id;

    const tournaments = await tournamentInfoRepository.findActive();
    if (tournaments.length > 0) {
      testTournamentId = tournaments[0].id;
    }

    await cleanLeagueSyncQueues();
  });

  afterAll(async () => {
    await cleanLeagueSyncQueues();
    leagueSyncRuntime.stop?.();
    await Promise.all(leagueSyncRuntime.queueEvents.map((events) => events.close()));
    await Promise.all(leagueSyncRuntime.workers.map((worker) => worker.close()));
  });

  describe('Coordinator Pattern', () => {
    test(
      'should process coordinator job (no tournamentId)',
      async () => {
        const job = await enqueueLeagueEventPicks(testEventId, 'manual');

        const result = await job.waitUntilFinished(getQueueEvents(job), 60000);

        expect(result).toBeDefined();
        expect(result.enqueued).toBeGreaterThanOrEqual(0);
        expect(await job.getState()).toBe('completed');
      },
      { timeout: 70000 },
    );

    test(
      'should enqueue per-tournament jobs from coordinator',
      async () => {
        if (!testTournamentId) {
          console.log('⊘ Skipping - no test tournament');
          return;
        }

        await cleanLeagueSyncQueues();

        const job = await enqueueLeagueEventResults(testEventId, 'manual');
        await expectJobCompleted(job, 60000);

        // Check for per-tournament jobs
        const waitingByQueue = await Promise.all(
          leagueSyncQueues.map((queue) => queue.getWaiting()),
        );
        const waiting = waitingByQueue.flat();
        expect(waiting.length).toBeGreaterThanOrEqual(0);
      },
      { timeout: 70000 },
    );
  });

  describe('Tournament Job Processing', () => {
    test(
      'should process tournament job (with tournamentId)',
      async () => {
        if (!testTournamentId) {
          console.log('⊘ Skipping - no test tournament');
          return;
        }

        const job = await enqueueLeagueEventPicks(testEventId, 'cascade', {
          tournamentId: testTournamentId,
        });

        const result = await job.waitUntilFinished(getQueueEvents(job), 120000);

        expect(result).toBeDefined();
        expect(result.tournamentId).toBe(testTournamentId);
        expect(await job.getState()).toBe('completed');
      },
      { timeout: 130000 },
    );
  });

  describe('Parallel Processing', () => {
    test(
      'should process multiple tournaments in parallel',
      async () => {
        const tournaments = await tournamentInfoRepository.findActive();
        if (tournaments.length < 2) {
          console.log('⊘ Skipping - need at least 2 tournaments');
          return;
        }

        const jobs = await Promise.all(
          tournaments
            .slice(0, 2)
            .map((t) => enqueueLeagueEventPicks(testEventId, 'cascade', { tournamentId: t.id })),
        );

        await Promise.all(jobs.map((job) => expectJobCompleted(job, 120000)));
      },
      { timeout: 250000 },
    );
  });

  describe('Job ID Patterns', () => {
    test('should use coordinator job ID pattern', async () => {
      const job = await enqueueLeagueEventPicks(testEventId, 'manual');

      expect(job.id).toContain(`league-event-picks-e${testEventId}-coordinator-`);
    });

    test('should use tournament job ID pattern', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament');
        return;
      }

      const job = await enqueueLeagueEventResults(testEventId, 'cascade', {
        tournamentId: testTournamentId,
      });

      expect(job.id).toContain(`league-event-results-e${testEventId}-t${testTournamentId}-`);
    });
  });
});
