import { assertIntegrationEnv } from '../helpers/env-guard';

assertIntegrationEnv();
import { QueueEvents, type Worker } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { enqueueTournamentEventPicks } from '../../../src/jobs/tournament-sync.jobs';
import {
  tournamentSyncQueue,
  tournamentSyncQueuesByTier,
  TOURNAMENT_JOBS,
} from '../../../src/queues/tournament-sync.queue';
import { getCurrentEvent } from '../../../src/services/events.service';
import { getQueueConnection } from '../../../src/utils/queue';
import { createTournamentSyncWorker } from '../../../src/workers/tournament-sync.worker';

let workerRuntime: ReturnType<typeof createTournamentSyncWorker>;

describe('Tournament Sync Worker Integration Tests', () => {
  let queueEvents: QueueEvents;
  let tournamentSyncWorker: Worker;
  let testEventId: number;

  beforeAll(async () => {
    await cleanTournamentQueues();

    workerRuntime = createTournamentSyncWorker();
    const worker = workerRuntime.workers[0];
    if (!worker) throw new Error('Tournament sync worker was not created');
    tournamentSyncWorker = worker;
    // Wait for worker to be ready
    await tournamentSyncWorker.waitUntilReady();

    // Setup queue events for job monitoring
    queueEvents = new QueueEvents(tournamentSyncQueue.name, {
      connection: getQueueConnection(),
    });

    // Get current event
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found');
    }
    testEventId = currentEvent.id;

    // Clean up queue after the worker is ready in case BullMQ recovered stale jobs on startup.
    await cleanTournamentQueues();
  });

  beforeEach(async () => {
    await pauseWorkers();
    await cleanTournamentQueues();
    await resumeWorkers();
  });

  afterAll(async () => {
    await pauseWorkers();
    await cleanTournamentQueues();
    workerRuntime.stop?.();
    await queueEvents.close();
    await Promise.all(workerRuntime.queueEvents.map((events) => events.close()));
    await Promise.all(workerRuntime.workers.map((worker) => worker.close()));
  });

  describe('Job Processing', () => {
    test(
      'should enqueue EVENT_PICKS job',
      async () => {
        // Synthetic / empty tournament data means the worker may fail on FPL
        // fetches; assert enqueue only so CI stays hermetic.
        const job = await enqueueTournamentEventPicks(testEventId, 'manual');
        expect(job).toBeDefined();
        expect(job.id).toBeDefined();
        expect(String(job.id)).toContain('tournament-event-picks');
      },
      { timeout: 15000 },
    );
  });

  describe('Cascade Mechanism', () => {
    test('should define EVENT_RESULTS as the cascade entrypoint', () => {
      expect(TOURNAMENT_JOBS.EVENT_RESULTS).toBe('tournament-event-results');
    });
  });

  describe('Error Handling', () => {
    test(
      'should handle unknown job names without hanging the worker',
      async () => {
        const job = await tournamentSyncQueue.add('unknown-tournament-job', {
          eventId: testEventId,
          source: 'manual',
          triggeredAt: new Date().toISOString(),
        });

        // Worker switch may fail or complete depending on default case handling.
        const freshJob = await waitForJobState(job.id ?? '', ['delayed', 'failed', 'completed']);
        const state = await freshJob.getState();

        expect(['delayed', 'failed', 'completed']).toContain(state);
      },
      { timeout: 15000 },
    );
  });

  describe('Concurrency', () => {
    test('should configure worker concurrency limits', () => {
      expect(tournamentSyncWorker.opts.concurrency).toBe(10);
    });
  });

  describe('Job ID Generation', () => {
    test('should create unique job IDs with timestamps', async () => {
      const job1 = await enqueueTournamentEventPicks(testEventId, 'manual');
      const job2 = await enqueueTournamentEventPicks(testEventId, 'manual');

      expect(job1.id).not.toBe(job2.id);
      expect(job1.id).toContain(`${TOURNAMENT_JOBS.EVENT_PICKS}-e${testEventId}-`);
      expect(job2.id).toContain(`${TOURNAMENT_JOBS.EVENT_PICKS}-e${testEventId}-`);
    });
  });
});

async function waitForJobState(jobId: string, expectedStates: string[]) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8_000) {
    const freshJob = await tournamentSyncQueue.getJob(jobId);
    if (!freshJob) {
      throw new Error(`Job ${jobId} disappeared before reaching expected state`);
    }

    const state = await freshJob.getState();
    if (expectedStates.includes(state)) {
      return freshJob;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Job ${jobId} did not reach expected state: ${expectedStates.join(', ')}`);
}

async function cleanTournamentQueues() {
  const uniqueQueues = [
    ...new Map(
      Object.values(tournamentSyncQueuesByTier).map((queue) => [queue.name, queue]),
    ).values(),
  ];

  await Promise.all(
    uniqueQueues.map(async (queue) => {
      await queue.drain(true);
      await queue.clean(0, 0, 'completed');
      await queue.clean(0, 0, 'failed');
      await queue.clean(0, 0, 'delayed');
    }),
  );
}

async function pauseWorkers() {
  await Promise.all(workerRuntime.workers.map((worker) => worker.pause(true)));
}

async function resumeWorkers() {
  await Promise.all(workerRuntime.workers.map((worker) => worker.resume()));
}
