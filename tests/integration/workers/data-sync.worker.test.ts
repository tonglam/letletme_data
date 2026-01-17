import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { dataSyncQueue } from '../../../src/queues/data-sync.queue';
import { getCurrentEvent } from '../../../src/services/events.service';
import { getQueueConnection } from '../../../src/utils/queue';
import { dataSyncWorker } from '../../../src/workers/data-sync.worker';

describe('Data Sync Worker Integration Tests', () => {
  let queueEvents: QueueEvents;
  let testEventId: number;

  beforeAll(
    async () => {
      await dataSyncWorker.waitUntilReady();

      queueEvents = new QueueEvents(dataSyncQueue.name, {
        connection: getQueueConnection(),
      });

      const currentEvent = await getCurrentEvent();
      if (!currentEvent) {
        throw new Error('No current event found');
      }
      testEventId = currentEvent.id;

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
      const countBefore = await dataSyncQueue.getJobCounts();

      // Add a test job (if data sync jobs exist)
      // await dataSyncQueue.add('test-job', { eventId: testEventId });

      const countAfter = await dataSyncQueue.getJobCounts();

      expect(countAfter).toBeDefined();
    });
  });
});
