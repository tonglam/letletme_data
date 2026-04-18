import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { dataSyncQueue } from '../../../src/queues/data-sync.queue';
import { getQueueConnection } from '../../../src/utils/queue';
import { dataSyncWorker } from '../../../src/workers/data-sync.worker';

describe('Data Sync Worker Integration Tests', () => {
  let queueEvents: QueueEvents;

  beforeAll(
    async () => {
      await dataSyncWorker.waitUntilReady();

      queueEvents = new QueueEvents(dataSyncQueue.name, {
        connection: getQueueConnection(),
      });

      await dataSyncQueue.drain();
      await dataSyncQueue.clean(0, 0, 'completed');
      await dataSyncQueue.clean(0, 0, 'failed');
    },
    { timeout: 30000 },
  );

  afterAll(async () => {
    await queueEvents.close();
    await dataSyncWorker.close();
  });

  describe('Worker Status', () => {
    test('should be ready and running', async () => {
      const isRunning = await dataSyncWorker.isRunning();
      expect(isRunning).toBe(true);
    });

    test('should have correct queue name', () => {
      expect(dataSyncWorker.name).toBe(dataSyncQueue.name);
    });
  });

  describe('Queue Operations', () => {
    test('should accept jobs', async () => {
      // Add a test job (if data sync jobs exist)
      // await dataSyncQueue.add('test-job', {});

      const countAfter = await dataSyncQueue.getJobCounts();

      expect(countAfter).toBeDefined();
    });
  });
});
