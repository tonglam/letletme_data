import { describe, it, expect, beforeAll } from 'vitest';

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

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-lives-cache');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'manual',
      });
    });

    it('should enqueue event lives DB sync job', async () => {
      const job = await enqueueEventLivesDbSync(TEST_EVENT_ID, 'manual');

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-lives-db');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'manual',
      });
    });

    it('should enqueue event live summary job', async () => {
      const job = await enqueueEventLiveSummary(TEST_EVENT_ID, 'cascade');

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-live-summary');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'cascade',
      });
    });

    it('should enqueue event live explain job', async () => {
      const job = await enqueueEventLiveExplain(TEST_EVENT_ID, 'cascade');

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-live-explain');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'cascade',
      });
    });

    it('should enqueue event overall result job', async () => {
      const job = await enqueueEventOverallResult(TEST_EVENT_ID, 'cascade');

      expect(job).toBeDefined();
      expect(job.id).toBeDefined();
      expect(job.name).toBe('event-overall-result');
      expect(job.data).toMatchObject({
        eventId: TEST_EVENT_ID,
        source: 'cascade',
      });
    });
  });

  describe('Job Deduplication', () => {
    it('should create unique job IDs with timestamp', async () => {
      const job1 = await enqueueEventLivesCacheUpdate(TEST_EVENT_ID, 'cron');
      const job2 = await enqueueEventLivesCacheUpdate(TEST_EVENT_ID, 'cron');

      expect(job1.id).not.toBe(job2.id);
      expect(job1.id).toContain('event-lives-cache');
      expect(job2.id).toContain('event-lives-cache');
    });
  });

  describe('Job Queue Validation', () => {
    it('should have correct default job options', async () => {
      const job = await enqueueEventLivesCacheUpdate(TEST_EVENT_ID, 'manual');

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

      expect(job.data.triggeredAt).toBeDefined();
      expect(job.data.triggeredAt >= beforeEnqueue).toBe(true);
      expect(job.data.triggeredAt <= afterEnqueue).toBe(true);
    });
  });

  describe('Job Queue Counts', () => {
    it('should track enqueued jobs', async () => {
      // Clean queue first
      await liveDataQueue.drain();

      await enqueueEventLivesCacheUpdate(TEST_EVENT_ID, 'manual');
      await enqueueEventLivesDbSync(TEST_EVENT_ID, 'manual');

      const waitingCount = await liveDataQueue.getWaitingCount();
      expect(waitingCount).toBeGreaterThanOrEqual(2);
    });
  });
});
