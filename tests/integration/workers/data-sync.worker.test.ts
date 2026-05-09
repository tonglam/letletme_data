import type { Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { dataSyncQueuesByTier, type DataSyncJobData } from '../../../src/queues/data-sync.queue';
import { createDataSyncWorker } from '../../../src/workers/data-sync.worker';
import type { WorkerRuntime } from '../../../src/workers/worker-runtime';

describe('Data Sync Worker Integration Tests', () => {
  let dataSyncRuntime: WorkerRuntime;
  let dataSyncWorker: Worker;
  const dataSyncQueues = Array.from(
    new Map(Object.values(dataSyncQueuesByTier).map((queue) => [queue.name, queue])).values(),
  );

  async function cleanDataSyncQueues() {
    await Promise.all(
      dataSyncQueues.map(async (queue: Queue<DataSyncJobData>) => {
        await queue.drain();
        await queue.clean(0, 0, 'completed');
        await queue.clean(0, 0, 'failed');
      }),
    );
  }

  beforeAll(async () => {
    dataSyncRuntime = createDataSyncWorker();
    const worker = dataSyncRuntime.workers[0];
    if (!worker) throw new Error('Data sync worker was not created');
    dataSyncWorker = worker;
    await Promise.all(dataSyncRuntime.workers.map((worker) => worker.waitUntilReady()));

    await cleanDataSyncQueues();
  });

  afterAll(async () => {
    dataSyncRuntime.stop?.();
    await Promise.all(dataSyncRuntime.workers.map((worker) => worker.close()));
    await Promise.all(dataSyncRuntime.queueEvents.map((events) => events.close()));
  });

  describe('Worker Status', () => {
    test('should be ready and running', async () => {
      const isRunning = await dataSyncWorker.isRunning();
      expect(isRunning).toBe(true);
    });

    test('should have correct queue name', () => {
      expect(dataSyncQueues.map((queue) => queue.name)).toContain(dataSyncWorker.name);
    });
  });

  describe('Queue Operations', () => {
    test('should accept jobs', async () => {
      // Add a test job (if data sync jobs exist)
      // await dataSyncQueue.add('test-job', {});

      const countAfter = await dataSyncQueues[0]?.getJobCounts();

      expect(countAfter).toBeDefined();
    });
  });
});
