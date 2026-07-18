import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { beforeAll, describe, expect, it } from 'bun:test';

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

  describe('Job ID Generation', () => {
    it('should use coordinator job ID pattern', async () => {
      const job = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'cron');

      expect(job.id).toMatch(new RegExp(`^league-event-picks-e${TEST_EVENT_ID}-coordinator-\\d+$`));
    });

    it('should use tournament job ID pattern', async () => {
      const job = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'cascade', {
        tournamentId: TEST_TOURNAMENT_ID,
      });

      expect(job.id).toMatch(
        new RegExp(`^league-event-picks-e${TEST_EVENT_ID}-t${TEST_TOURNAMENT_ID}-\\d+$`),
      );
    });

    it('creates coordinator cron jobs with event-scoped IDs', async () => {
      const eventId = 940_000 + (Date.now() % 100_000);
      const job1 = await enqueueLeagueEventPicks(eventId, 'cron');
      await Bun.sleep(2);
      const job2 = await enqueueLeagueEventPicks(eventId, 'cron');

      expect(job1).not.toBeNull();
      expect(job2).not.toBeNull();
      expect(String(job1!.id)).toContain(`e${eventId}`);
      // League sync uses timestamped IDs — concurrent cron runs get distinct jobs.
      expect(job1!.id).not.toBe(job2!.id);
    });

    it('creates separate tournament cascade job runs', async () => {
      const eventId = 920_000 + (Date.now() % 100_000);
      const tournamentId = 930_000 + (Date.now() % 100_000);
      const job1 = await enqueueLeagueEventResults(eventId, 'cascade', {
        tournamentId,
      });
      await Bun.sleep(2);
      const job2 = await enqueueLeagueEventResults(eventId, 'cascade', {
        tournamentId,
      });

      expect(job1).not.toBeNull();
      expect(job2).not.toBeNull();
      expect(job1!.id).not.toBe(job2!.id);
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

      const picksJob = await enqueueLeagueEventPicks(TEST_EVENT_ID, 'manual');
      const resultsJob = await enqueueLeagueEventResults(TEST_EVENT_ID, 'manual');

      const states = await Promise.all([picksJob.getState(), resultsJob.getState()]);
      expect(
        states.every((state) => ['waiting', 'delayed', 'active', 'completed'].includes(state)),
      ).toBe(true);
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
