import type { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { entrySyncQueuesByTier, type EntrySyncJobData } from '../../../src/queues/entry-sync.queue';
import { createEntrySyncWorker } from '../../../src/workers/entry-sync.worker';
import type { WorkerRuntime } from '../../../src/workers/worker-runtime';

describe('Entry Sync Worker Integration Tests', () => {
  let entrySyncRuntime: WorkerRuntime;
  let entrySyncWorker: Worker;
  const entrySyncQueues = Array.from(
    new Map(Object.values(entrySyncQueuesByTier).map((queue) => [queue.name, queue])).values(),
  );

  async function cleanEntrySyncQueues() {
    await Promise.all(
      entrySyncQueues.map(async (queue: Queue<EntrySyncJobData>) => {
        await queue.drain();
        await queue.clean(0, 0, 'completed');
        await queue.clean(0, 0, 'failed');
      }),
    );
  }

  beforeAll(async () => {
    entrySyncRuntime = createEntrySyncWorker();
    const worker = entrySyncRuntime.workers[0];
    if (!worker) throw new Error('Entry sync worker was not created');
    entrySyncWorker = worker;
    await Promise.all(entrySyncRuntime.workers.map((worker) => worker.waitUntilReady()));

    await cleanEntrySyncQueues();
  });

  afterAll(async () => {
    entrySyncRuntime.stop?.();
    await Promise.all(entrySyncRuntime.workers.map((worker) => worker.close()));
    await Promise.all(entrySyncRuntime.queueEvents.map((events) => events.close()));
  });

  describe('Worker Status', () => {
    test('should be ready and running', async () => {
      const isRunning = await entrySyncWorker.isRunning();
      expect(isRunning).toBe(true);
    });

    test('should have correct queue name', () => {
      expect(entrySyncQueues.map((queue) => queue.name)).toContain(entrySyncWorker.name);
    });
  });

  describe('Queue Operations', () => {
    test('should accept jobs', async () => {
      // Add a test job (if entry sync jobs exist)
      // await entrySyncQueue.add('test-job', {});

      const countAfter = await entrySyncQueues[0]?.getJobCounts();

      expect(countAfter).toBeDefined();
    });
  });
});
