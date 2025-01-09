import { config } from 'dotenv';
config();

import { Job, QueueEvents } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createSchedulerService } from '../../../src/infrastructure/queue/core/scheduler.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService } from '../../../src/infrastructure/queue/types';
import { QueueError, QueueErrorCode, createQueueError } from '../../../src/types/error.type';
import { JobName, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData } from '../../utils/queue.test.utils';

describe('Scheduler Queue Integration Tests', () => {
  const queueName = 'test-scheduler-queue';
  const defaultJobName = 'meta' as JobName;
  let queueService: QueueService<MetaJobData>;
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
    const queueServiceResult = await createQueueServiceImpl<MetaJobData>(queueName)();
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

  describe('Scheduler Queue Integration', () => {
    test('should schedule and process jobs', async () => {
      const processedJobs: MetaJobData[] = [];

      const result = await pipe(
        TE.Do,
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(
            queueName,
            async ({ data }: Job<MetaJobData>) => {
              processedJobs.push(data);
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain((services) => {
          const schedulerService = createSchedulerService<MetaJobData>(
            queueName,
            queueService.getQueue(),
          );
          return TE.right({ ...services, schedulerService });
        }),
        TE.chain((services) =>
          pipe(
            TE.tryCatch(
              async () => {
                const jobData = createTestMetaJobData({ name: defaultJobName });
                await services.schedulerService.upsertJobScheduler(
                  'test-scheduler',
                  { every: 1000 },
                  {
                    name: defaultJobName,
                    data: jobData,
                  },
                )();
                await waitForJobCompletion(1);
                return services.workerService.close()();
              },
              (error) => error as QueueError,
            ),
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
