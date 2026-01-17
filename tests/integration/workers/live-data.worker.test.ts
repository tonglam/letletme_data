import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  enqueueEventLiveExplain,
  enqueueEventLivesCacheUpdate,
  enqueueEventLivesDbSync,
  enqueueEventLiveSummary,
  enqueueEventOverallResult,
} from '../../../src/jobs/live-data.jobs';
import { liveDataQueue } from '../../../src/queues/live-data.queue';
import { getCurrentEvent } from '../../../src/services/events.service';
import { getQueueConnection } from '../../../src/utils/queue';
import { liveDataWorker } from '../../../src/workers/live-data.worker';

describe('Live Data Worker Integration Tests', () => {
  let queueEvents: QueueEvents;
  let testEventId: number;

  beforeAll(
    async () => {
      await liveDataWorker.waitUntilReady();

      queueEvents = new QueueEvents(liveDataQueue.name, {
        connection: getQueueConnection(),
      });

      const currentEvent = await getCurrentEvent();
      if (!currentEvent) {
        throw new Error('No current event found');
      }
      testEventId = currentEvent.id;

      await liveDataQueue.drain();
      await liveDataQueue.clean(0, 0, 'completed');
      await liveDataQueue.clean(0, 0, 'failed');
    },
    { timeout: 30000 },
  );

  afterAll(async () => {
    await queueEvents.close();
    await liveDataWorker.close();
  });

  describe('Event Lives Jobs', () => {
    test(
      'should process event lives cache update',
      async () => {
        const job = await enqueueEventLivesCacheUpdate(testEventId);

        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
        expect(result.count).toBeGreaterThan(0);
      },
      { timeout: 70000 },
    );

    test(
      'should process event lives DB sync',
      async () => {
        const job = await enqueueEventLivesDbSync(testEventId);

        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
        expect(result.count).toBeGreaterThan(0);
      },
      { timeout: 70000 },
    );
  });

  describe('Summary and Explain Jobs', () => {
    test(
      'should process event live summary',
      async () => {
        // Need event lives data first
        await enqueueEventLivesDbSync(testEventId);

        const job = await enqueueEventLiveSummary();

        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
        expect(result.count).toBeGreaterThan(0);
      },
      { timeout: 70000 },
    );

    test(
      'should process event live explain',
      async () => {
        const job = await enqueueEventLiveExplain(testEventId);

        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
        expect(result.count).toBeGreaterThan(0);
      },
      { timeout: 70000 },
    );
  });

  describe('Overall Results Job', () => {
    test(
      'should process event overall result',
      async () => {
        const job = await enqueueEventOverallResult();

        const result = await job.waitUntilFinished(queueEvents, 60000);

        expect(result).toBeDefined();
        expect(result.count).toBeGreaterThan(0);
      },
      { timeout: 70000 },
    );
  });

  describe('Parallel Job Processing', () => {
    test(
      'should process multiple live data jobs in parallel',
      async () => {
        const jobs = await Promise.all([
          enqueueEventLivesCacheUpdate(testEventId),
          enqueueEventLiveExplain(testEventId),
          enqueueEventOverallResult(),
        ]);

        await Promise.all(jobs.map((job) => job.waitUntilFinished(queueEvents, 60000)));

        jobs.forEach((job) => {
          expect(job.finishedOn).toBeDefined();
        });
      },
      { timeout: 180000 },
    );
  });

  describe('Job ID Generation', () => {
    test('should create unique job IDs with timestamp', async () => {
      const job1 = await enqueueEventLivesCacheUpdate(testEventId);
      const job2 = await enqueueEventLivesCacheUpdate(testEventId);

      // Should have different IDs due to timestamp
      expect(job1.id).not.toBe(job2.id);
    });
  });
});
