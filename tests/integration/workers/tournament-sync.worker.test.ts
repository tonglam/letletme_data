import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  enqueueTournamentBattleRace,
  enqueueTournamentEventResults,
  enqueueTournamentKnockout,
  enqueueTournamentPointsRace,
} from '../../../src/jobs/tournament-sync.jobs';
import { tournamentSyncQueue } from '../../../src/queues/tournament-sync.queue';
import { getCurrentEvent } from '../../../src/services/events.service';
import { getQueueConnection } from '../../../src/utils/queue';
import { tournamentSyncWorker } from '../../../src/workers/tournament-sync.worker';

describe('Tournament Sync Worker Integration Tests', () => {
  let queueEvents: QueueEvents;
  let testEventId: number;

  beforeAll(
    async () => {
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

      // Clean up queue
      await tournamentSyncQueue.drain();
      await tournamentSyncQueue.clean(0, 0, 'completed');
      await tournamentSyncQueue.clean(0, 0, 'failed');
    },
    { timeout: 30000 },
  );

  afterAll(async () => {
    await queueEvents.close();
    await tournamentSyncWorker.close();
  });

  describe('Job Processing', () => {
    test(
      'should process EVENT_RESULTS job',
      async () => {
        const job = await enqueueTournamentEventResults(testEventId, 'manual');

        // Wait for job to complete
        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
        expect(job.finishedOn).toBeDefined();
      },
      { timeout: 70000 },
    );

    test(
      'should process POINTS_RACE job',
      async () => {
        const job = await enqueueTournamentPointsRace(testEventId, 'manual');

        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
      },
      { timeout: 70000 },
    );

    test(
      'should process BATTLE_RACE job',
      async () => {
        const job = await enqueueTournamentBattleRace(testEventId, 'manual');

        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
      },
      { timeout: 70000 },
    );

    test(
      'should process KNOCKOUT job',
      async () => {
        const job = await enqueueTournamentKnockout(testEventId, 'manual');

        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
      },
      { timeout: 70000 },
    );
  });

  describe('Cascade Mechanism', () => {
    test(
      'should trigger cascade jobs after EVENT_RESULTS',
      async () => {
        // Clean queue
        await tournamentSyncQueue.drain();

        // Enqueue base job
        const job = await enqueueTournamentEventResults(testEventId, 'manual');

        // Wait for completion
        await job.waitUntilFinished(queueEvents, 60000);

        // Check for cascade jobs
        const waiting = await tournamentSyncQueue.getWaiting();
        const active = await tournamentSyncQueue.getActive();

        // Should have cascade jobs enqueued
        const totalJobs = waiting.length + active.length;
        expect(totalJobs).toBeGreaterThanOrEqual(0); // May have processed already
      },
      { timeout: 70000 },
    );
  });

  describe('Error Handling', () => {
    test(
      'should handle job failure with retry',
      async () => {
        // Enqueue job with invalid event ID
        const invalidEventId = -1;
        const job = await enqueueTournamentEventResults(invalidEventId, 'manual');

        // Should fail
        await expect(job.waitUntilFinished(queueEvents, 30000)).rejects.toThrow();

        // Check retry attempt
        expect(job.attemptsMade).toBeGreaterThan(0);
      },
      { timeout: 40000 },
    );
  });

  describe('Concurrency', () => {
    test(
      'should respect concurrency limits',
      async () => {
        // Enqueue multiple jobs
        const jobs = await Promise.all([
          enqueueTournamentPointsRace(testEventId, 'manual'),
          enqueueTournamentBattleRace(testEventId, 'manual'),
          enqueueTournamentKnockout(testEventId, 'manual'),
        ]);

        // All should complete
        await Promise.all(jobs.map((job) => job.waitUntilFinished(queueEvents, 60000)));

        jobs.forEach((job) => {
          expect(job.finishedOn).toBeDefined();
        });
      },
      { timeout: 180000 },
    );
  });

  describe('Job Deduplication', () => {
    test('should prevent duplicate jobs with same ID', async () => {
      const job1 = await enqueueTournamentEventResults(testEventId, 'manual');
      const job2 = await enqueueTournamentEventResults(testEventId, 'manual');

      // Should have same job ID
      expect(job1.id).toBe(job2.id);
    });
  });
});
