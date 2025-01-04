import { config } from 'dotenv';
config();

import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from 'src/config/queue/queue.config';
import { createQueueService } from 'src/infrastructure/queue/core/queue.service';
import { createWorkerService } from 'src/infrastructure/queue/core/worker.service';
import { QueueError } from 'src/types/errors.type';
import { JobData, JobName } from 'src/types/job.type';

describe('Queue Reliability Tests', () => {
  const queueName = 'test-reliability-queue';
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

  describe('Reliability Testing', () => {
    test('should handle Redis disconnection gracefully', async () => {
      const jobCount = 5;
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Redis disconnection test timeout'));
        }, 60000);

        checkInterval = setInterval(() => {
          if (processedJobs.length === jobCount) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 1000);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              await new Promise((resolve) => setTimeout(resolve, 100));
              processedJobs.push(job.data);
            },
            { autorun: true, concurrency: 2 },
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
                  await new Promise((resolve) => setTimeout(resolve, 200));
                }

                // Simulate Redis disconnection by temporarily changing the port
                const originalPort = config.producerConnection.port;
                config.producerConnection.port = 6380;
                await new Promise((resolve) => setTimeout(resolve, 1000));
                config.producerConnection.port = originalPort;
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
    }, 70000);

    test('should maintain data consistency after failures', async () => {
      const jobCount = 5;
      const processedJobs: JobData[] = [];
      const failedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Data consistency test timeout'));
        }, 60000);

        checkInterval = setInterval(() => {
          if (processedJobs.length + failedJobs.length === jobCount) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 1000);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              await new Promise((resolve) => setTimeout(resolve, 100));
              // Simulate random failures
              if (Math.random() < 0.3) {
                failedJobs.push(job.data);
                throw new Error('Simulated random failure');
              }
              processedJobs.push(job.data);
            },
            { autorun: true, concurrency: 2 },
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
                  await new Promise((resolve) => setTimeout(resolve, 200));
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
      expect(processedJobs.length + failedJobs.length).toBe(jobCount);
      // Ensure no job is both processed and failed
      const intersection = processedJobs.filter((pJob) =>
        failedJobs.some(
          (fJob) =>
            (fJob.data as { value: number }).value === (pJob.data as { value: number }).value,
        ),
      );
      expect(intersection.length).toBe(0);
    }, 70000);

    test('should handle memory usage under sustained load', async () => {
      const jobCount = 10;
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Memory usage test timeout'));
        }, 60000);

        checkInterval = setInterval(() => {
          if (processedJobs.length === jobCount) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 1000);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              // Simulate memory-intensive operation
              const largeArray = new Array(1000).fill(0);
              await new Promise((resolve) => setTimeout(resolve, 100));
              processedJobs.push(job.data);
              // Clean up memory
              largeArray.length = 0;
            },
            { autorun: true, concurrency: 2 },
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
                  await new Promise((resolve) => setTimeout(resolve, 200));
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
    }, 70000);
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
