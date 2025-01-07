import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createSchedulerService } from '../../../src/infrastructure/queue/core/scheduler.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService } from '../../../src/infrastructure/queue/types';
import { QueueError } from '../../../src/types/errors.type';
import { JobName, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData, createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Scheduler Queue Integration Tests', () => {
  const queueName = 'test-scheduler-queue';
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

  // Cleanup before and after each test
  beforeEach(async () => {
    const cleanup = await pipe(
      createQueueServiceImpl<MetaJobData>(queueName, config),
      TE.chain((service: QueueService<MetaJobData>) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });

  afterEach(async () => {
    const cleanup = await pipe(
      createQueueServiceImpl<MetaJobData>(queueName, config),
      TE.chain((service: QueueService<MetaJobData>) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });

  describe('Scheduler Queue Integration', () => {
    test('should schedule and process jobs', async () => {
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
            console.log(`Processing job ${job.id} with data:`, job.data);
            processedJobs.push(job.data);
            console.log(`Job ${job.id} processed successfully`);
          }),
        ),
        TE.chain((services) => {
          const schedulerService = createSchedulerService<MetaJobData>(
            queueName,
            services.queueService.getQueue(),
          );
          return TE.right({ ...services, schedulerService });
        }),
        TE.chain((services) =>
          pipe(
            services.schedulerService.upsertJobScheduler(
              'test-scheduler',
              { every: 1000 },
              {
                name: defaultJobName,
                data: createTestMetaJobData({ name: defaultJobName }),
              },
            ),
            TE.chain(() =>
              TE.tryCatch(
                () => jobProcessed,
                (error) => error as QueueError,
              ),
            ),
            TE.chain(() => services.workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(1);
      expect(processedJobs[0].type).toBe('META');
      expect(processedJobs[0].name).toBe(defaultJobName);
    }, 30000);
  });
});
