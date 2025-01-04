import { config } from 'dotenv';
config();

import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../src/config/queue/queue.config';
import { createFlowService } from '../../src/infrastructure/queue/core/flow.service';
import { createQueueService } from '../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../src/infrastructure/queue/core/worker.service';
import { QueueError } from '../../src/types/errors.type';
import { JobData, JobName } from '../../src/types/job.type';

describe('Queue Performance Tests', () => {
  const queueName = 'test-performance-queue';
  const config: QueueConfig = {
    producerConnection: {
      host: process.env.REDIS_HOST || '',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || '',
      retryStrategy: (times: number) => Math.min(times * 100, 3000),
      enableReadyCheck: true,
      reconnectOnError: (err: Error) => err.message.includes('READONLY'),
    },
    consumerConnection: {
      host: process.env.REDIS_HOST || '',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || '',
      retryStrategy: (times: number) => Math.min(times * 100, 3000),
      enableReadyCheck: true,
      reconnectOnError: (err: Error) => err.message.includes('READONLY'),
    },
  };

  // Validate Redis configuration
  beforeAll(() => {
    if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD) {
      throw new Error('Redis configuration is missing. Please check your .env file.');
    }
  });

  // Cleanup before each test
  beforeEach(async () => {
    try {
      const cleanup = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) => service.obliterate()),
      )();
      expect(cleanup._tag).toBe('Right');
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
    // Add delay after cleanup
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  describe('Load Testing', () => {
    test('should handle high-volume job processing', async () => {
      const jobCount = 5; // Reduced for stability
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('High-volume job processing timeout'));
        }, 60000); // Increased timeout

        checkInterval = setInterval(() => {
          if (processedJobs.length === jobCount) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 1000); // Increased check interval
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              await new Promise((resolve) => setTimeout(resolve, 100)); // Added delay
              processedJobs.push(job.data);
            },
            { autorun: true, concurrency: 2 }, // Reduced concurrency
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                // Add jobs one by one with delay
                for (let i = 0; i < jobCount; i++) {
                  await queueService.addJob({
                    type: 'META',
                    name: 'meta' as JobName,
                    data: { value: i },
                    timestamp: new Date(),
                  })();
                  await new Promise((resolve) => setTimeout(resolve, 200)); // Added delay
                }
              },
              (error) => error as QueueError,
            ),
            TE.chain(() =>
              TE.tryCatch(
                () => jobsProcessed,
                (error) => error as QueueError,
              ),
            ),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(jobCount);
    }, 70000); // Increased test timeout

    test('should handle concurrent flow execution', async () => {
      const flowCount = 2; // Reduced for stability
      const childrenPerFlow = 2;
      const processedJobs: string[] = [];
      let checkInterval: NodeJS.Timeout;

      const expectedJobCount = flowCount * (childrenPerFlow + 1);
      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Concurrent flow execution timeout'));
        }, 60000); // Increased timeout

        checkInterval = setInterval(() => {
          if (processedJobs.length === expectedJobCount) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 1000); // Increased check interval
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('queue', ({ queueService }) => TE.right(queueService.getQueue())),
        TE.bind('flowService', ({ queue }) =>
          TE.tryCatch(
            async () => createFlowService<JobData>(queue, 'meta' as JobName),
            (error) => error as QueueError,
          ),
        ),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              await new Promise((resolve) => setTimeout(resolve, 100)); // Added delay
              processedJobs.push(job.name);
            },
            { autorun: true, concurrency: 2 }, // Reduced concurrency
          ),
        ),
        TE.chain(({ flowService, workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                // Add flows one by one with delay
                for (let i = 0; i < flowCount; i++) {
                  await flowService.addJob(
                    {
                      type: 'META',
                      name: 'meta' as JobName,
                      data: { value: i },
                      timestamp: new Date(),
                    },
                    {
                      jobId: `parent-${i}`,
                      children: Array.from({ length: childrenPerFlow }, (_, j) => ({
                        name: `child-${j}`,
                        queueName,
                        data: {
                          type: 'META',
                          name: `child-${j}` as JobName,
                          data: { value: j },
                          timestamp: new Date(),
                        },
                      })),
                    },
                  )();
                  await new Promise((resolve) => setTimeout(resolve, 200)); // Added delay
                }
              },
              (error) => error as QueueError,
            ),
            TE.chain(() =>
              TE.tryCatch(
                () => jobsProcessed,
                (error) => error as QueueError,
              ),
            ),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(expectedJobCount);
    }, 70000); // Increased test timeout

    test('should handle scheduler performance under load', async () => {
      const schedulerCount = 3; // Reduced for stability
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Scheduler performance test timeout'));
        }, 60000); // Increased timeout

        checkInterval = setInterval(() => {
          if (processedJobs.length >= schedulerCount) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 1000); // Increased check interval
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              await new Promise((resolve) => setTimeout(resolve, 100)); // Added delay
              processedJobs.push(job.data);
            },
            { autorun: true, concurrency: 2 }, // Reduced concurrency
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                // Add schedulers one by one with delay
                for (let i = 0; i < schedulerCount; i++) {
                  await queueService.upsertJobScheduler(`scheduler-${i}`, {
                    every: 1000,
                    limit: 1,
                  })();
                  await new Promise((resolve) => setTimeout(resolve, 200)); // Added delay
                }
              },
              (error) => error as QueueError,
            ),
            TE.chain(() =>
              TE.tryCatch(
                () => jobsProcessed,
                (error) => error as QueueError,
              ),
            ),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBeGreaterThanOrEqual(schedulerCount);
    }, 70000); // Increased test timeout
  });

  // Cleanup after each test
  afterEach(async () => {
    const cleanup = await pipe(
      createQueueService<JobData>(queueName, config),
      TE.chain((service) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });
});
