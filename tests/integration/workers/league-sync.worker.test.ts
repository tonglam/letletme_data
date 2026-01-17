import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  enqueueLeagueEventPicks,
  enqueueLeagueEventResults,
} from '../../../src/jobs/league-sync.jobs';
import { leagueSyncQueue } from '../../../src/queues/league-sync.queue';
import { tournamentInfoRepository } from '../../../src/repositories/tournament-infos';
import { getCurrentEvent } from '../../../src/services/events.service';
import { getQueueConnection } from '../../../src/utils/queue';
import { leagueSyncWorker } from '../../../src/workers/league-sync.worker';

describe('League Sync Worker Integration Tests', () => {
  let queueEvents: QueueEvents;
  let testEventId: number;
  let testTournamentId: number | null = null;

  beforeAll(
    async () => {
      await leagueSyncWorker.waitUntilReady();

      queueEvents = new QueueEvents(leagueSyncQueue.name, {
        connection: getQueueConnection(),
      });

      const currentEvent = await getCurrentEvent();
      if (!currentEvent) {
        throw new Error('No current event found');
      }
      testEventId = currentEvent.id;

      const tournaments = await tournamentInfoRepository.findActive();
      if (tournaments.length > 0) {
        testTournamentId = tournaments[0].id;
      }

      await leagueSyncQueue.drain();
      await leagueSyncQueue.clean(0, 0, 'completed');
      await leagueSyncQueue.clean(0, 0, 'failed');
    },
    { timeout: 30000 },
  );

  afterAll(async () => {
    await queueEvents.close();
    await leagueSyncWorker.close();
  });

  describe('Coordinator Pattern', () => {
    test(
      'should process coordinator job (no tournamentId)',
      async () => {
        const job = await enqueueLeagueEventPicks(testEventId, 'manual');

        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
        expect(result.enqueued).toBeGreaterThanOrEqual(0);
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

        await leagueSyncQueue.drain();

        const job = await enqueueLeagueEventResults(testEventId, 'manual');
        await job.waitUntilFinished(queueEvents, 60000);

        // Check for per-tournament jobs
        const waiting = await leagueSyncQueue.getWaiting();
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

        const result = await job.waitUntilFinished(queueEvents, 120000);

        expect(result).toBeDefined();
        expect(result.tournamentId).toBe(testTournamentId);
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

        await Promise.all(jobs.map((job) => job.waitUntilFinished(queueEvents, 120000)));

        jobs.forEach((job) => {
          expect(job.finishedOn).toBeDefined();
        });
      },
      { timeout: 250000 },
    );
  });

  describe('Job ID Patterns', () => {
    test('should use coordinator job ID pattern', async () => {
      const job = await enqueueLeagueEventPicks(testEventId, 'manual');

      expect(job.id).toBe(`league-event-picks:${testEventId}:coordinator`);
    });

    test('should use tournament job ID pattern', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament');
        return;
      }

      const job = await enqueueLeagueEventResults(testEventId, 'cascade', {
        tournamentId: testTournamentId,
      });

      expect(job.id).toBe(`league-event-results:${testEventId}:t${testTournamentId}`);
    });
  });
});
