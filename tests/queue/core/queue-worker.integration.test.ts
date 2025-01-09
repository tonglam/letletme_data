import { config } from 'dotenv';
config();

import { Job, QueueEvents } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService } from '../../../src/infrastructure/queue/types';
import { QueueError, QueueErrorCode, createQueueError } from '../../../src/types/error.type';
import { JobData, JobName, MetaType } from '../../../src/types/job.type';

describe('Queue-Worker Integration Tests', () => {
  const queueName = 'test-worker-queue';
  const defaultJobName = 'meta' as JobName;
  let queueService: QueueService<JobData>;
  let queueEvents: QueueEvents;

  // Validate Redis configuration
  beforeAll(() => {
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
  }, 10000);

  afterAll(async () => {
    await queueEvents.close();
  }, 10000);

  const createTestJob = (): JobData => ({
    type: 'META',
    name: defaultJobName,
    timestamp: new Date(),
    data: {
      operation: 'SYNC',
      metaType: 'EVENTS' as MetaType,
    },
  });

  // Helper function to clean up queue
  const cleanupQueue = async (): Promise<void> => {
    if (!queueService) return;

    try {
      const queue = queueService.getQueue();
      await queue.pause();
      await queue.obliterate();
      await queue.resume();
    } catch (error) {
      console.warn('Queue cleanup warning:', error);
    }
  };

  // Helper function to wait for job completion
  const waitForJobCompletion = async (jobCount: number): Promise<void> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          createQueueError(
            QueueErrorCode.PROCESSING_ERROR,
            queueName,
            new Error('Job completion timeout'),
          ),
        );
      }, 10000);

      let completed = 0;
      const onCompleted = async () => {
        completed++;
        if (completed === jobCount) {
          clearTimeout(timeout);
          queueEvents.off('completed', onCompleted);
          queueEvents.off('failed', onFailed);
          resolve();
        }
      };

      const onFailed = async ({ failedReason }: { failedReason: string }) => {
        clearTimeout(timeout);
        queueEvents.off('completed', onCompleted);
        queueEvents.off('failed', onFailed);
        reject(
          createQueueError(QueueErrorCode.PROCESSING_ERROR, queueName, new Error(failedReason)),
        );
      };

      queueEvents.on('completed', onCompleted);
      queueEvents.on('failed', onFailed);
    });
  };

  // Setup before each test
  beforeEach(async () => {
    const queueServiceResult = await createQueueServiceImpl<JobData>(queueName)();
    if (queueServiceResult._tag === 'Left') {
      throw new Error('Failed to create queue service');
    }
    queueService = queueServiceResult.right;
    await cleanupQueue();
  }, 30000);

  // Cleanup after each test
  afterEach(async () => {
    if (queueService) {
      await cleanupQueue();
      await queueService.close()();
    }
  }, 30000);

  describe('End-to-End Job Processing', () => {
    test('should process job successfully', async () => {
      const processedJobs: JobData[] = [];

      const result = await pipe(
        TE.Do,
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            async ({ data }: Job<JobData>) => {
              processedJobs.push(data);
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain(({ workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                const job = createTestJob();
                await queueService.addJob(job)();
                await waitForJobCompletion(1);
                return workerService.close()();
              },
              (error) => error as QueueError,
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(1);
      expect(processedJobs[0].type).toBe('META');
    }, 30000);

    test('should handle concurrent job processing', async () => {
      const processedJobs: JobData[] = [];
      const concurrency = 3;
      const jobCount = 5;

      const result = await pipe(
        TE.Do,
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            async ({ data }: Job<JobData>) => {
              await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate work
              processedJobs.push(data);
            },
            { concurrency },
          ),
        ),
        TE.chain(({ workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                const jobs = Array.from({ length: jobCount }, () => ({
                  data: createTestJob(),
                }));
                await queueService.addBulk(jobs)();
                await waitForJobCompletion(jobCount);
                return workerService.close()();
              },
              (error) => error as QueueError,
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(jobCount);
    }, 30000);

    test('should handle job failure and retry', async () => {
      let attempts = 0;

      const result = await pipe(
        TE.Do,
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            async () => {
              attempts++;
              if (attempts === 1) {
                throw new Error('Simulated failure');
              }
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain(({ workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                const job = createTestJob();
                await queueService.addJob(job, {
                  attempts: 2,
                  backoff: {
                    type: 'fixed',
                    delay: 1000,
                  },
                })();
                await waitForJobCompletion(1);
                return workerService.close()();
              },
              (error) => error as QueueError,
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(attempts).toBe(2);
    }, 30000);

    test('should handle worker recovery after disconnection', async () => {
      const processedJobs: JobData[] = [];

      const result = await pipe(
        TE.Do,
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            async ({ data }: Job<JobData>) => {
              processedJobs.push(data);
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain(({ workerService }) =>
          pipe(
            workerService.close(),
            TE.chain(() => {
              return createWorkerService<JobData>(
                queueName,
                async ({ data }: Job<JobData>) => {
                  processedJobs.push(data);
                },
                { concurrency: 1 },
              );
            }),
            TE.chain((newWorker) =>
              pipe(
                TE.tryCatch(
                  async () => {
                    const job = createTestJob();
                    await queueService.addJob(job)();
                    await waitForJobCompletion(1);
                    return newWorker.close()();
                  },
                  (error) => error as QueueError,
                ),
              ),
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(1);
    }, 30000);

    test('should process jobs with worker', async () => {
      const jobData = createTestJob();
      const processedJobs: JobData[] = [];

      const result = await pipe(
        TE.Do,
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            async ({ data }: Job<JobData>) => {
              processedJobs.push(data);
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain(({ workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                await queueService.addJob(jobData)();
                await waitForJobCompletion(1);
                return workerService.close()();
              },
              (error) => error as QueueError,
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(1);
      expect(processedJobs[0].type).toBe(jobData.type);
      expect(processedJobs[0].name).toBe(jobData.name);
      expect(processedJobs[0].data).toEqual(jobData.data);
    }, 30000);
  });
});
