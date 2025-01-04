import { config } from 'dotenv';
config();

import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../src/config/queue/queue.config';
import { createQueueService } from '../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../src/infrastructure/queue/core/worker.service';
import { JobScheduler } from '../../src/infrastructure/queue/types';
import { QueueError } from '../../src/types/errors.type';
import { JobData } from '../../src/types/job.type';

describe('Scheduler-Queue Integration Tests', () => {
  const queueName = 'test-scheduler-queue';
  const config: QueueConfig = {
    producerConnection: {
      host: process.env.REDIS_HOST || '',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || '',
    },
    consumerConnection: {
      host: process.env.REDIS_HOST || '',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || '',
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

  describe('Scheduled Job Processing', () => {
    test('should execute scheduled job with interval pattern', async () => {
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(
            new Error(
              'Scheduled jobs processing timeout - jobs were not processed within the expected timeframe',
            ),
          );
        }, 20000);

        checkInterval = setInterval(() => {
          if (processedJobs.length === 2) {
            // We expect 2 jobs to be processed
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
              processedJobs.push(job.data);
            },
            { autorun: true },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            queueService.upsertJobScheduler('interval-job', {
              every: 500, // Run every 500ms
              limit: 2, // Run twice
            }),
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
      expect(processedJobs.length).toBe(2);
    }, 30000);

    test('should execute scheduled job with cron pattern', async () => {
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(
            new Error(
              'Scheduled jobs processing timeout - jobs were not processed within the expected timeframe',
            ),
          );
        }, 20000);

        checkInterval = setInterval(() => {
          if (processedJobs.length === 2) {
            // We expect 2 jobs to be processed
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
              processedJobs.push(job.data);
            },
            { autorun: true },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            queueService.upsertJobScheduler('cron-job', {
              pattern: '*/1 * * * * *', // Run every second
              limit: 2, // Run twice
            }),
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
      expect(processedJobs.length).toBe(2);
    }, 30000);

    test('should list job schedulers with pagination', async () => {
      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.chain(({ queueService }) =>
          pipe(
            // Add first scheduler
            queueService.upsertJobScheduler('scheduler-1', {
              pattern: '*/5 * * * * *',
            }),
            // Add second scheduler
            TE.chain(() =>
              queueService.upsertJobScheduler('scheduler-2', {
                every: 1000,
              }),
            ),
            // Add third scheduler
            TE.chain(() =>
              queueService.upsertJobScheduler('scheduler-3', {
                every: 2000,
              }),
            ),
            // Get first page with size 2
            TE.chain(() =>
              queueService.getJobSchedulers({
                page: 1,
                pageSize: 2,
              }),
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const schedulers = result.right as JobScheduler[];
        expect(schedulers.length).toBe(2);
        expect(['scheduler-1', 'scheduler-2', 'scheduler-3']).toContain(schedulers[0].jobId);
        expect(['scheduler-1', 'scheduler-2', 'scheduler-3']).toContain(schedulers[1].jobId);
        expect(schedulers[0].jobId).not.toBe(schedulers[1].jobId);
      }

      // Get second page
      const secondPage = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) =>
          service.getJobSchedulers({
            page: 2,
            pageSize: 2,
          }),
        ),
      )();

      expect(secondPage._tag).toBe('Right');
      if (secondPage._tag === 'Right') {
        const schedulers = secondPage.right as JobScheduler[];
        expect(schedulers.length).toBe(1);
        expect(['scheduler-1', 'scheduler-2', 'scheduler-3']).toContain(schedulers[0].jobId);
      }
    }, 30000);

    test('should handle scheduler failure and recovery', async () => {
      const processedJobs: JobData[] = [];
      let attempts = 0;
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(
            new Error(
              'Scheduled jobs processing timeout - jobs were not processed within the expected timeframe',
            ),
          );
        }, 20000);

        checkInterval = setInterval(() => {
          if (attempts === 2 && processedJobs.length === 1) {
            // We expect 2 attempts and 1 successful job
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
              attempts++;
              if (attempts === 1) {
                throw new Error('Simulated failure');
              }
              processedJobs.push(job.data);
            },
            { autorun: true },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            queueService.upsertJobScheduler('failing-job', {
              every: 500,
              limit: 2,
            }),
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
      expect(attempts).toBe(2);
      expect(processedJobs.length).toBe(1); // Second attempt should succeed
    }, 30000);
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
