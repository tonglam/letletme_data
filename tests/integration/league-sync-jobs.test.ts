import { beforeAll, describe, expect, it } from 'vitest';

import {
  enqueueLeagueEventPicks,
  enqueueLeagueEventResults,
} from '../../src/jobs/league-sync.jobs';
import { leagueSyncQueue } from '../../src/queues/league-sync.queue';

describe('League Sync Jobs Integration', () => {
  const TEST_EVENT_ID = 10;
  const TEST_TOURNAMENT_ID = 1;

  beforeAll(async () => {
    // Clean up queue before tests
    await leagueSyncQueue.drain();
    await leagueSyncQueue.clean(0, 0, 'completed');
    await leagueSyncQueue.clean(0, 0, 'failed');
  });

  describe('Job Enqueueing', () => {
    it('should enqueue league event picks coordinator job', async () => {
      const job = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'manual');

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('league-event-picks');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        tournamentId: undefined,
        source: 'manual',
      });
    });

    it('should enqueue league event picks tournament job', async () => {
      const job = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'cascade', {
        tournamentId: TEST_TOURNAMENT_ID,
      });

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('league-event-picks');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        tournamentId: TEST_TOURNAMENT_ID,
        source: 'cascade',
      });
    });

    it('should enqueue league event results coordinator job', async () => {
      const job = await enqueueLeagueEventResults(TEST_EVENT_ID, 'manual');

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('league-event-results');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        tournamentId: undefined,
        source: 'manual',
      });
    });

    it('should enqueue league event results tournament job', async () => {
      const job = await enqueueLeagueEventResults(TEST_EVENT_ID, 'cascade', {
        tournamentId: TEST_TOURNAMENT_ID,
      });

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('league-event-results');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        tournamentId: TEST_TOURNAMENT_ID,
        source: 'cascade',
      });
    });
  });

  describe('Job Deduplication', () => {
    it('should use coordinator job ID pattern', async () => {
      const job = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'cron');

      expect(job.id).toBe(`league-event-picks:${TEST_EVENT_ID}:coordinator`);
    });

    it('should use tournament job ID pattern', async () => {
      const job = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'cascade', {
        tournamentId: TEST_TOURNAMENT_ID,
      });

      expect(job.id).toBe(`league-event-picks:${TEST_EVENT_ID}:t${TEST_TOURNAMENT_ID}`);
    });

    it('should prevent duplicate coordinator jobs', async () => {
      const job1 = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'cron');
      const job2 = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'cron');

      // Same job ID should return the existing job
      expect(job1.id).toBe(job2.id);
    });

    it('should prevent duplicate tournament jobs', async () => {
      const job1 = await enqueueLeagueEventResults(TEST_EVENT_ID, 'cascade', {
        tournamentId: TEST_TOURNAMENT_ID,
      });
      const job2 = await enqueueLeagueEventResults(TEST_EVENT_ID, 'cascade', {
        tournamentId: TEST_TOURNAMENT_ID,
      });

      expect(job1.id).toBe(job2.id);
    });
  });

  describe('Job Queue Validation', () => {
    it('should have correct default job options', async () => {
      const job = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'manual');

      expect(job.opts.attempts).toBe(3);
      expect(job.opts.backoff).toMatchObject({
        type: 'exponential',
        delay: 60_000,
      });
    });

    it('should store triggeredAt timestamp', async () => {
      const beforeEnqueue = new Date().toISOString();
      const job = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'manual');
      const afterEnqueue = new Date().toISOString();

      expect(job.data.triggeredAt).toBeDefined();
      expect(job.data.triggeredAt >= beforeEnqueue).toBe(true);
      expect(job.data.triggeredAt <= afterEnqueue).toBe(true);
    });
  });

  describe('Job Queue Counts', () => {
    it('should track enqueued jobs', async () => {
      // Clean queue first
      await leagueSyncQueue.drain();

      await enqueueLeagueEventPicks(TEST_EVENT_ID, 'manual');
      await enqueueLeagueEventResults(TEST_EVENT_ID, 'manual');

      const waitingCount = await leagueSyncQueue.getWaitingCount();
      expect(waitingCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Coordinator vs Tournament Jobs', () => {
    it('should differentiate coordinator and tournament jobs by data', async () => {
      const coordinatorJob = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'cron');
      const tournamentJob = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'cascade', {
        tournamentId: TEST_TOURNAMENT_ID,
      });

      expect(coordinatorJob.data.tournamentId).toBeUndefined();
      expect(tournamentJob.data.tournamentId).toBe(TEST_TOURNAMENT_ID);
    });
  });
});
