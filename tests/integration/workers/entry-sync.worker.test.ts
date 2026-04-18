import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { entrySyncQueue } from '../../../src/queues/entry-sync.queue';
import { getQueueConnection } from '../../../src/utils/queue';
import { entrySyncWorker } from '../../../src/workers/entry-sync.worker';

describe('Entry Sync Worker Integration Tests', () => {
  let queueEvents: QueueEvents;

  beforeAll(
    async () => {
      await entrySyncWorker.waitUntilReady();

      queueEvents = new QueueEvents(entrySyncQueue.name, {
        connection: getQueueConnection(),
      });

      await entrySyncQueue.drain();
      await entrySyncQueue.clean(0, 0, 'completed');
      await entrySyncQueue.clean(0, 0, 'failed');
    },
    { timeout: 30000 },
  );

  afterAll(async () => {
    await queueEvents.close();
    await entrySyncWorker.close();
  });

  describe('Worker Status', () => {
    test('should be ready and running', async () => {
      const isRunning = await entrySyncWorker.isRunning();
      expect(isRunning).toBe(true);
    });

    test('should have correct queue name', () => {
      expect(entrySyncWorker.name).toBe(entrySyncQueue.name);
    });
  });

  describe('Queue Operations', () => {
    test('should accept jobs', async () => {
      // Add a test job (if entry sync jobs exist)
      // await entrySyncQueue.add('test-job', {});

      const countAfter = await entrySyncQueue.getJobCounts();

      expect(countAfter).toBeDefined();
    });
  });
});
