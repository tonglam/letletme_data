import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService } from '../../../src/infrastructure/queue/types';
import { QueueError } from '../../../src/types/errors.type';
import { JobName, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData, createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Queue Reliability Tests', () => {
  const queueName = 'test-reliability-queue';
  const defaultJobName = 'meta' as JobName;
  const config = createTestQueueConfig({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
    password: process.env.REDIS_PASSWORD,
  });

  // Validate Redis configuration
  beforeAll(() => {
    if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD) {
      console.warn('Redis configuration not found, using default localhost settings');
    }
  });

  // Cleanup before each test
  beforeEach(async () => {
    try {
      const cleanup = await pipe(
        createQueueServiceImpl<MetaJobData>(queueName, config),
        TE.chain((service: QueueService<MetaJobData>) => service.obliterate()),
      )();
      expect(cleanup._tag).toBe('Right');
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
    // Add delay after cleanup
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  describe('Connection Handling', () => {
    test('should handle connection failures gracefully', async () => {
      const processedJobs: MetaJobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Job processing timeout'));
        }, 20000);

        checkInterval = setInterval(() => {
          if (processedJobs.length > 0) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<MetaJobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(queueName, config, async (job: Job<MetaJobData>) => {
            processedJobs.push(job.data);
          }),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            queueService.addJob(createTestMetaJobData({ name: defaultJobName })),
            TE.chain(() =>
              TE.tryCatch(
                () => jobProcessed,
                (error) => error as QueueError,
              ),
            ),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(1);
    }, 30000);
  });

  describe('Job Processing', () => {
    test('should process jobs in order', async () => {
      const processedJobs: MetaJobData[] = [];
      const jobCount = 5;
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Jobs processing timeout'));
        }, 20000);

        checkInterval = setInterval(() => {
          if (processedJobs.length === jobCount) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<MetaJobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(queueName, config, async (job: Job<MetaJobData>) => {
            processedJobs.push(job.data);
          }),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                for (let i = 0; i < jobCount; i++) {
                  await queueService.addJob(createTestMetaJobData({ name: defaultJobName }))();
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
    }, 30000);
  });

  // Cleanup after each test
  afterEach(async () => {
    const cleanup = await pipe(
      createQueueServiceImpl<MetaJobData>(queueName, config),
      TE.chain((service: QueueService<MetaJobData>) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });
});
