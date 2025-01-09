import { config } from 'dotenv';
config();

import { Job, Queue, QueueEvents } from 'bullmq';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueError } from '../../../src/types/error.type';
import { JobData, JobName, MetaType } from '../../../src/types/job.type';
import { createTestMetaJobData } from '../../utils/queue.test.utils';

describe('Queue Performance Tests', () => {
  const queueName = 'test-queue';
  const defaultJobName = 'meta' as JobName;
  let queue: Queue<JobData>;
  let queueEvents: QueueEvents | undefined;

  beforeAll(async () => {
    if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD) {
      throw new Error('Redis configuration is missing. Please check your .env file.');
    }

    queueEvents = new QueueEvents(queueName, {
      connection: {
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD,
      },
    });

    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    if (queueEvents) {
      await queueEvents.close();
    }
  });

  const waitForJobCompletion = (jobId: string, timeoutMs = 30000): Promise<void> => {
    if (!queueEvents) {
      return Promise.reject(new Error('Queue events not initialized'));
    }

    const queueEventsInstance = queueEvents;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        queueEventsInstance.off('completed', onCompleted);
        queueEventsInstance.off('failed', onFailed);
        reject(new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`));
      }, timeoutMs);

      const onCompleted = async ({ jobId: completedJobId }: { jobId: string }) => {
        if (completedJobId === jobId) {
          clearTimeout(timeout);
          queueEventsInstance.off('completed', onCompleted);
          queueEventsInstance.off('failed', onFailed);
          resolve();
        }
      };

      const onFailed = async ({
        jobId: failedJobId,
        failedReason,
      }: {
        jobId: string;
        failedReason: string;
      }) => {
        if (failedJobId === jobId) {
          clearTimeout(timeout);
          queueEventsInstance.off('completed', onCompleted);
          queueEventsInstance.off('failed', onFailed);
          reject(new Error(`Job ${jobId} failed: ${failedReason}`));
        }
      };

      queueEventsInstance.on('completed', onCompleted);
      queueEventsInstance.on('failed', onFailed);
    });
  };

  const cleanupQueue = async (queue: Queue<JobData>): Promise<void> => {
    try {
      await queue.obliterate();
    } catch (error) {
      console.warn('Queue cleanup warning:', error);
    }
  };

  beforeEach(async () => {
    const queueServiceE = await createQueueServiceImpl<JobData>(queueName)();
    if (E.isRight(queueServiceE)) {
      queue = queueServiceE.right.getQueue();
      await cleanupQueue(queue);
    }
  });

  afterEach(async () => {
    if (queue) {
      await cleanupQueue(queue);
    }
  });

  it('should handle high-volume job processing with different concurrency levels', async () => {
    const jobCount = 10;
    const concurrencyLevels = [1, 2, 3];
    const results: { concurrency: number; duration: number; throughput: number }[] = [];

    for (const concurrency of concurrencyLevels) {
      const processedJobs = new Set<string>();
      const startTime = Date.now();

      const queueServiceE = await createQueueServiceImpl<JobData>(queueName)();
      expect(E.isRight(queueServiceE)).toBe(true);
      if (!E.isRight(queueServiceE)) return;

      const workerServiceE = await createWorkerService<JobData>(
        queueName,
        async (job: Job<JobData>) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (job.id) processedJobs.add(job.id);
        },
        { concurrency },
      )();

      expect(E.isRight(workerServiceE)).toBe(true);
      if (!E.isRight(workerServiceE)) return;

      const jobPromises: Promise<void>[] = [];

      // Add jobs
      for (let i = 0; i < jobCount; i++) {
        const jobId = `test-job-${i}`;
        const result = await queueServiceE.right.addJob(
          createTestMetaJobData({
            name: defaultJobName,
            operation: 'SYNC',
            metaType: 'EVENTS' as MetaType,
          }),
          {
            jobId,
            attempts: 3,
            backoff: {
              type: 'fixed',
              delay: 1000,
            },
          },
        )();

        expect(result._tag).toBe('Right');
        jobPromises.push(waitForJobCompletion(jobId));
      }

      try {
        await Promise.all(jobPromises);

        const duration = Date.now() - startTime;
        const throughput = (jobCount / duration) * 1000;

        results.push({
          concurrency,
          duration,
          throughput,
        });

        expect(processedJobs.size).toBe(jobCount);
      } finally {
        await pipe(
          workerServiceE.right.close(),
          TE.chain(() => queueServiceE.right.drain()),
        )();
      }
    }

    console.table(results);
  }, 180000);

  it('should handle concurrent flow execution with performance tracking', async () => {
    const flowCount = 3;
    const processedJobs = new Set<string>();
    const startTime = Date.now();

    const queueServiceE = await createQueueServiceImpl<JobData>(queueName)();
    expect(E.isRight(queueServiceE)).toBe(true);
    if (!E.isRight(queueServiceE)) return;

    const workerServiceE = await createWorkerService<JobData>(
      queueName,
      async (job: Job<JobData>) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (job.id) processedJobs.add(job.id);
      },
      { concurrency: 3 },
    )();

    expect(E.isRight(workerServiceE)).toBe(true);
    if (!E.isRight(workerServiceE)) return;

    const flowPromises = Array.from({ length: flowCount }, async (_, i) => {
      const jobId = `flow-${i}`;
      const result = await queueServiceE.right.addJob(
        createTestMetaJobData({
          name: defaultJobName,
          operation: 'SYNC',
          metaType: 'EVENTS' as MetaType,
        }),
        {
          jobId,
          attempts: 3,
          backoff: {
            type: 'fixed',
            delay: 1000,
          },
        },
      )();

      return result;
    });

    const results = await Promise.all(flowPromises);
    const result = results.every((r: E.Either<QueueError, unknown>) => r._tag === 'Right');
    expect(result).toBe(true);

    try {
      const completionPromises = Array.from({ length: flowCount }, (_, i) =>
        waitForJobCompletion(`flow-${i}`, 60000),
      );
      await Promise.all(completionPromises);

      const duration = Date.now() - startTime;
      const throughput = (flowCount / duration) * 1000;

      console.log('Flow Performance:', {
        duration: `${duration}ms`,
        throughput: `${throughput.toFixed(2)} jobs/s`,
        totalJobs: flowCount,
      });

      expect(processedJobs.size).toBe(flowCount);
    } finally {
      await pipe(
        workerServiceE.right.close(),
        TE.chain(() => queueServiceE.right.drain()),
      )();
    }
  }, 70000);
});
