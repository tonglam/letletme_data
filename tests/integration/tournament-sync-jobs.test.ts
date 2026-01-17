import { beforeAll, describe, expect, it } from 'vitest';

import {
  enqueueTournamentEventResults,
  enqueueTournamentEventPicks,
  enqueueTournamentPointsRace,
  enqueueTournamentBattleRace,
  enqueueTournamentKnockout,
  enqueueTournamentTransfersPost,
  enqueueTournamentCupResults,
  enqueueTournamentTransfersPre,
} from '../../src/jobs/tournament-sync.jobs';
import { tournamentSyncQueue } from '../../src/queues/tournament-sync.queue';

describe('Tournament Sync Jobs Integration', () => {
  const TEST_EVENT_ID = 10;

  beforeAll(async () => {
    // Clean up queue before tests
    await tournamentSyncQueue.drain();
    await tournamentSyncQueue.clean(0, 0, 'completed');
    await tournamentSyncQueue.clean(0, 0, 'failed');
  });

  describe('Job Enqueueing', () => {
    it('should enqueue tournament event results (base job)', async () => {
      const job = await enqueueTournamentEventResults(TEST_EVENT_ID, 'manual');

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('tournament-event-results');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'manual',
      });
    });

    it('should enqueue tournament event picks job', async () => {
      const job = await enqueueTournamentEventPicks(TEST_EVENT_ID, 'cron');

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('tournament-event-picks');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'cron',
      });
    });

    it('should enqueue cascade jobs', async () => {
      const jobs = await Promise.all([
        enqueueTournamentPointsRace(TEST_EVENT_ID, 'cascade'),
        enqueueTournamentBattleRace(TEST_EVENT_ID, 'cascade'),
        enqueueTournamentKnockout(TEST_EVENT_ID, 'cascade'),
        enqueueTournamentTransfersPost(TEST_EVENT_ID, 'cascade'),
        enqueueTournamentCupResults(TEST_EVENT_ID, 'cascade'),
      ]);

      expect(jobs).toHaveLength(5);
      jobs.forEach((job) => {
        expect(job).toBeDefined();
        expect(job.data.source).toBe('cascade');
        expect(job.data.eventId).toBe(TEST_EVENT_ID);
      });
    });

    it('should enqueue tournament transfers pre job', async () => {
      const job = await enqueueTournamentTransfersPre(TEST_EVENT_ID, 'cron');

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('tournament-transfers-pre');
    });
  });

  describe('Job Deduplication', () => {
    it('should use consistent job ID pattern', async () => {
      const job1 = await enqueueTournamentEventResults(TEST_EVENT_ID, 'cron');
      const job2 = await enqueueTournamentEventResults(TEST_EVENT_ID, 'cron');

      // Same job ID should return the existing job
      expect(job1.id).toBe(job2.id);
      expect(job1.id).toBe(`tournament-event-results-e${TEST_EVENT_ID}`);
    });

    it('should prevent duplicate cascade jobs', async () => {
      const job1 = await enqueueTournamentPointsRace(TEST_EVENT_ID, 'cascade');
      const job2 = await enqueueTournamentPointsRace(TEST_EVENT_ID, 'cascade');

      expect(job1.id).toBe(job2.id);
      expect(job1.id).toBe(`tournament-points-race-e${TEST_EVENT_ID}`);
    });
  });

  describe('Job Queue Validation', () => {
    it('should have correct default job options', async () => {
      const job = await enqueueTournamentEventResults(TEST_EVENT_ID, 'manual');

      expect(job.opts.attempts).toBe(3);
      expect(job.opts.backoff).toMatchObject({
        type: 'exponential',
        delay: 60_000,
      });
    });

    it('should store triggeredAt timestamp', async () => {
      const beforeEnqueue = new Date().toISOString();
      const job = await enqueueTournamentEventResults(TEST_EVENT_ID, 'manual');
      const afterEnqueue = new Date().toISOString();

      expect(job.data.triggeredAt).toBeDefined();
      expect(job.data.triggeredAt >= beforeEnqueue).toBe(true);
      expect(job.data.triggeredAt <= afterEnqueue).toBe(true);
    });
  });

  describe('Job Queue Counts', () => {
    it('should track enqueued jobs', async () => {
      // Clean queue first
      await tournamentSyncQueue.drain();

      await enqueueTournamentEventResults(TEST_EVENT_ID, 'manual');
      await enqueueTournamentEventPicks(TEST_EVENT_ID, 'manual');

      const waitingCount = await tournamentSyncQueue.getWaitingCount();
      expect(waitingCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Job Types', () => {
    it('should differentiate base, cascade, and independent jobs by name', async () => {
      const baseJob = await enqueueTournamentEventResults(TEST_EVENT_ID, 'cron');
      const cascadeJob = await enqueueTournamentPointsRace(TEST_EVENT_ID, 'cascade');
      const independentJob = await enqueueTournamentEventPicks(TEST_EVENT_ID, 'cron');

      expect(baseJob.name).toBe('tournament-event-results');
      expect(cascadeJob.name).toBe('tournament-points-race');
      expect(independentJob.name).toBe('tournament-event-picks');

      // Base and cascade should have same eventId
      expect(baseJob.data.eventId).toBe(cascadeJob.data.eventId);
      expect(baseJob.data.eventId).toBe(independentJob.data.eventId);
    });
  });
});
