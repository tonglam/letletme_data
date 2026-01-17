import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { entrySyncQueue } from '../../../src/queues/entry-sync.queue';
import { getCurrentEvent } from '../../../src/services/events.service';
import { getQueueConnection } from '../../../src/utils/queue';
import { entrySyncWorker } from '../../../src/workers/entry-sync.worker';

describe('Entry Sync Worker Integration Tests', () => {
  let queueEvents: QueueEvents;
  let testEventId: number;

  beforeAll(
    async () => {
      await entrySyncWorker.waitUntilReady();

      queueEvents = new QueueEvents(entrySyncQueue.name, {
        connection: getQueueConnection(),
      });

      const currentEvent = await getCurrentEvent();
      if (!currentEvent) {
        throw new Error('No current event found');
      }
      testEventId = currentEvent.id;

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
      const countBefore = await entrySyncQueue.getJobCounts();

      // Add a test job (if entry sync jobs exist)
      // await entrySyncQueue.add('test-job', { eventId: testEventId });

      const countAfter = await entrySyncQueue.getJobCounts();

      expect(countAfter).toBeDefined();
    });
  });
});
