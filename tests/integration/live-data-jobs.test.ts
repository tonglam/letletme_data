import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { describe, it, expect, beforeAll } from 'bun:test';

import {
  enqueueEventLivesCacheUpdate,
  enqueueEventLivesDbSync,
  enqueueEventLiveSummary,
  enqueueEventLiveExplain,
  enqueueEventOverallResult,
} from '../../src/jobs/live-data.jobs';
import { liveDataQueue } from '../../src/queues/live-data.queue';

describe('Live Data Jobs Integration', () => {
  const TEST_EVENT_ID = 10;

  beforeAll(async () => {
    // Clean up queue before tests
    await liveDataQueue.drain();
    await liveDataQueue.clean(0, 0, 'completed');
    await liveDataQueue.clean(0, 0, 'failed');
  });

  describe('Job Enqueueing', () => {
    it('should enqueue event lives cache update job', async () => {
      const job = await enqueueEventLivesCacheUpdate(TEST_EVENT_ID, 'manual');
      if (!job) throw new Error('Expected job to be enqueued');

      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-lives-cache');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'manual',
      });
    });

    it('should enqueue event lives DB sync job', async () => {
      const job = await enqueueEventLivesDbSync(TEST_EVENT_ID, 'manual');
      if (!job) throw new Error('Expected job to be enqueued');

      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-lives-db');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'manual',
      });
    });

    it('should enqueue event live summary job', async () => {
      const job = await enqueueEventLiveSummary(TEST_EVENT_ID, 'cascade');
      if (!job) throw new Error('Expected job to be enqueued');

      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-live-summary');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'cascade',
      });
    });

    it('should enqueue event live explain job', async () => {
      const job = await enqueueEventLiveExplain(TEST_EVENT_ID, 'cascade');
      if (!job) throw new Error('Expected job to be enqueued');

      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-live-explain');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'cascade',
      });
    });

    it('should enqueue event overall result job', async () => {
      const job = await enqueueEventOverallResult(TEST_EVENT_ID, 'cascade');
      if (!job) throw new Error('Expected job to be enqueued');

      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-overall-result');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'cascade',
      });
    });
  });

  describe('Job Deduplication', () => {
    it('dedupes concurrent cron enqueues for the same event (waiting-room)', async () => {
      // FP-14: deterministic job IDs mean a second enqueue while the first is
      // still waiting returns null instead of forking a duplicate chain.
      // Use a unique event id so earlier tests do not leave a waiting job.
      const eventId = 900_000 + (Date.now() % 100_000);
      const job1 = await enqueueEventLivesCacheUpdate(eventId, 'cron');
      const job2 = await enqueueEventLivesCacheUpdate(eventId, 'cron');

      expect(job1).not.toBeNull();
      expect(String(job1!.id)).toContain('event-lives-cache');
      // Second call is skipped while the first job is still in the waiting room.
      expect(job2 === null || job2.id === job1!.id).toBe(true);
    });
  });

  describe('Job Queue Validation', () => {
    it('should have correct default job options', async () => {
      const job = await enqueueEventLivesCacheUpdate(TEST_EVENT_ID, 'manual');
      if (!job) throw new Error('Expected job to be enqueued');

      expect(job.opts.attempts).toBe(3);
      expect(job.opts.backoff).toMatchObject({
        type: 'exponential',
        delay: 60_000,
      });
    });

    it('should store triggeredAt timestamp', async () => {
      const beforeEnqueue = new Date().toISOString();
      const job = await enqueueEventLivesCacheUpdate(TEST_EVENT_ID, 'manual');
      const afterEnqueue = new Date().toISOString();
      if (!job) throw new Error('Expected job to be enqueued');

      expect(job.data.triggeredAt).toBeDefined();
      expect(job.data.triggeredAt >= beforeEnqueue).toBe(true);
      expect(job.data.triggeredAt <= afterEnqueue).toBe(true);
    });
  });

  describe('Job Queue Counts', () => {
    it('should track enqueued jobs', async () => {
      // Clean queue first
      await liveDataQueue.drain();

      const jobs = await Promise.all([
        enqueueEventLivesCacheUpdate(TEST_EVENT_ID, 'manual'),
        enqueueEventLivesDbSync(TEST_EVENT_ID, 'manual'),
      ]);
      if (jobs.some((job) => !job)) throw new Error('Expected all jobs to be enqueued');

      const states = await Promise.all(jobs.map((job) => job!.getState()));
      expect(states).toHaveLength(2);
      states.forEach((state) => {
        expect(['waiting', 'delayed', 'active', 'completed']).toContain(state);
      });
    });
  });
});
