import type { Job, Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  enqueueEventLiveExplain,
  enqueueEventLivesCacheUpdate,
  enqueueEventLivesDbSync,
  enqueueEventLiveSummary,
  enqueueEventOverallResult,
} from '../../../src/jobs/live-data.jobs';
import { liveDataQueuesByTier, type LiveDataJobData } from '../../../src/queues/live-data.queue';
import { getCurrentEvent } from '../../../src/services/events.service';
import { createLiveDataWorker } from '../../../src/workers/live-data.worker';
import type { WorkerRuntime } from '../../../src/workers/worker-runtime';

describe('Live Data Worker Integration Tests', () => {
  let liveDataRuntime: WorkerRuntime;
  let testEventId: number;

  const liveDataQueues = Array.from(
    new Map(Object.values(liveDataQueuesByTier).map((queue) => [queue.name, queue])).values(),
  );

  async function cleanLiveDataQueues() {
    await Promise.all(
      liveDataQueues.map(async (queue: Queue<LiveDataJobData>) => {
        await queue.drain();
        await queue.clean(0, 0, 'completed');
        await queue.clean(0, 0, 'failed');
      }),
    );
  }

  function getQueueEvents(job: Job<LiveDataJobData>) {
    const target = liveDataRuntime.monitorTargets.find(
      ({ queueName }) => queueName === job.queueName,
    );
    if (!target) {
      throw new Error(`No QueueEvents found for queue ${job.queueName}`);
    }
    return target.queueEvents;
  }

  async function expectJobCompleted(job: Job<LiveDataJobData>, timeout: number) {
    await job.waitUntilFinished(getQueueEvents(job), timeout);
    expect(await job.getState()).toBe('completed');
  }

  beforeAll(async () => {
    liveDataRuntime = createLiveDataWorker();
    if (liveDataRuntime.workers.length === 0) throw new Error('Live data worker was not created');
    await Promise.all(liveDataRuntime.workers.map((worker) => worker.waitUntilReady()));

    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found');
    }
    testEventId = currentEvent.id;

    await cleanLiveDataQueues();
  });

  afterAll(async () => {
    await Promise.all(liveDataRuntime.queueEvents.map((events) => events.close()));
    await Promise.all(liveDataRuntime.workers.map((worker) => worker.close()));
    liveDataRuntime.stop?.();
  });

  describe('Event Lives Jobs', () => {
    test(
      'should process event lives cache update',
      async () => {
        const job = await enqueueEventLivesCacheUpdate(testEventId);

        await expectJobCompleted(job, 60000);
      },
      { timeout: 70000 },
    );

    test(
      'should process event lives DB sync',
      async () => {
        const job = await enqueueEventLivesDbSync(testEventId);

        await expectJobCompleted(job, 60000);
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

        const job = await enqueueEventLiveSummary(testEventId);

        await expectJobCompleted(job, 60000);
      },
      { timeout: 70000 },
    );

    test(
      'should process event live explain',
      async () => {
        const job = await enqueueEventLiveExplain(testEventId);

        await expectJobCompleted(job, 60000);
      },
      { timeout: 70000 },
    );
  });

  describe('Overall Results Job', () => {
    test(
      'should process event overall result',
      async () => {
        const job = await enqueueEventOverallResult(testEventId);

        await expectJobCompleted(job, 60000);
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
          enqueueEventOverallResult(testEventId),
        ]);

        await Promise.all(jobs.map((job) => expectJobCompleted(job, 60000)));
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
