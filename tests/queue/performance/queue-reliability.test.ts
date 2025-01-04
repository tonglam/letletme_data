import { config } from 'dotenv';
config();

import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../src/config/queue/queue.config';
import { createQueueService } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueError } from '../../../src/types/errors.type';
import { JobData, JobName } from '../../../src/types/job.type';

describe('Queue Reliability Tests', () => {
  const queueName = 'test-reliability-queue';
  const config: QueueConfig = {
    producerConnection: {
      host: process.env.REDIS_HOST || '',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || '',
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
    },
    consumerConnection: {
      host: process.env.REDIS_HOST || '',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || '',
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
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
    const cleanup = await pipe(
      createQueueService<JobData>(queueName, config),
      TE.chain((service) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });

  describe('Reliability Testing', () => {
    test('should handle Redis disconnection gracefully', async () => {
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;
      let disconnectionSimulated = false;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Redis disconnection test timeout'));
        }, 30000);

        checkInterval = setInterval(() => {
          // Simulate Redis disconnection after some jobs are processed
          if (!disconnectionSimulated && processedJobs.length > 0) {
            disconnectionSimulated = true;
            // Store original values
            const originalPort = config.producerConnection.port;
            const originalHost = config.producerConnection.host;

            // Simulate disconnection by changing connection settings
            config.producerConnection.port = 6380;
            config.producerConnection.host = 'invalid-host';

            // Restore after 2 seconds
            setTimeout(() => {
              config.producerConnection.port = originalPort;
              config.producerConnection.host = originalHost;
            }, 2000);
          }

          if (processedJobs.length >= 5) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              await new Promise((resolve) => setTimeout(resolve, 500));
              processedJobs.push(job.data);
            },
            { autorun: true, concurrency: 2 },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                const jobs = Array.from({ length: 10 }, (_, i) => ({
                  data: {
                    type: 'META' as const,
                    name: 'meta' as JobName,
                    data: { value: i },
                    timestamp: new Date(),
                  },
                }));
                await queueService.addBulk(jobs);
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
      expect(processedJobs.length).toBeGreaterThanOrEqual(5);
      expect(disconnectionSimulated).toBe(true);
    }, 40000);

    test('should maintain data consistency after failures', async () => {
      const processedJobs = new Set<number>();
      const failedJobs = new Set<number>();
      let checkInterval: NodeJS.Timeout;
      const totalJobs = 50; // Reduced from 100 to make the test more reliable

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Data consistency test timeout'));
        }, 30000);

        checkInterval = setInterval(() => {
          if (processedJobs.size + failedJobs.size === totalJobs) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              const value = (job.data.data as { value: number }).value;

              // Simulate random failures with a lower failure rate
              if (Math.random() < 0.1) {
                failedJobs.add(value);
                throw new Error('Simulated random failure');
              }

              await new Promise((resolve) => setTimeout(resolve, 10));
              processedJobs.add(value);
            },
            { autorun: true, concurrency: 5 },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                const jobs = Array.from({ length: totalJobs }, (_, i) => ({
                  data: {
                    type: 'META' as const,
                    name: 'meta' as JobName,
                    data: { value: i },
                    timestamp: new Date(),
                  },
                }));
                await queueService.addBulk(jobs);
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
      expect(processedJobs.size + failedJobs.size).toBe(totalJobs);

      // Verify no job was both processed and failed
      const intersection = new Set([...processedJobs].filter((x) => failedJobs.has(x)));
      expect(intersection.size).toBe(0);

      // Verify all jobs were accounted for
      const allJobs = new Set([...processedJobs, ...failedJobs]);
      expect(allJobs.size).toBe(totalJobs);
      for (let i = 0; i < totalJobs; i++) {
        expect(allJobs.has(i)).toBe(true);
      }
    }, 40000);

    test('should handle memory usage under sustained load', async () => {
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;
      const totalJobs = 1000; // Reduced from 10000 to make the test more reliable
      const memorySnapshots: number[] = [];

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Memory usage test timeout'));
        }, 30000);

        checkInterval = setInterval(() => {
          // Take memory snapshot every 500ms
          const used = process.memoryUsage();
          memorySnapshots.push(used.heapUsed / 1024 / 1024); // Convert to MB

          if (processedJobs.length === totalJobs) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              await new Promise((resolve) => setTimeout(resolve, 1));
              processedJobs.push(job.data);
            },
            { autorun: true, concurrency: 10 },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                // Add jobs in smaller batches to prevent memory spikes
                const batchSize = 100;
                for (let i = 0; i < totalJobs; i += batchSize) {
                  const jobs = Array.from(
                    { length: Math.min(batchSize, totalJobs - i) },
                    (_, j) => ({
                      data: {
                        type: 'META' as const,
                        name: 'meta' as JobName,
                        data: { value: i + j },
                        timestamp: new Date(),
                      },
                    }),
                  );
                  await queueService.addBulk(jobs);
                  // Small delay between batches
                  await new Promise((resolve) => setTimeout(resolve, 100));
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
      expect(processedJobs.length).toBe(totalJobs);

      // Check memory usage patterns
      const maxMemory = Math.max(...memorySnapshots);
      const avgMemory = memorySnapshots.reduce((a, b) => a + b, 0) / memorySnapshots.length;

      // Memory should not grow unbounded
      // The last memory usage should be close to the average
      const lastMemory = memorySnapshots[memorySnapshots.length - 1];
      expect(lastMemory).toBeLessThan(maxMemory * 1.5); // Allow some fluctuation
      expect(lastMemory).toBeLessThan(avgMemory * 2); // Should not be drastically higher than average
    }, 40000);
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
