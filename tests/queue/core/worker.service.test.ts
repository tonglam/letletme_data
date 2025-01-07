import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService, WorkerService } from '../../../src/infrastructure/queue/types';
import { QueueError } from '../../../src/types/errors.type';
import { JobName, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData, createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Worker Service Tests', () => {
  const queueName = 'test-worker-queue';
  const defaultJobName: JobName = 'meta';
  const queueConfig = createTestQueueConfig();

  describe('Core Operations', () => {
    test('should create worker with configuration', async () => {
      const result = await pipe(
        createWorkerService<MetaJobData>(
          queueName,
          queueConfig,
          async () => {
            // Empty processor
          },
          { concurrency: 1 },
        ),
        TE.map((service): WorkerService<MetaJobData> => service),
        TE.chain((service) => service.close()),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should process jobs successfully', async () => {
      const processedJobs: JobName[] = [];
      let jobsProcessed = 0;

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () =>
          pipe(
            createQueueServiceImpl<MetaJobData>(queueName, queueConfig),
            TE.map((service): QueueService<MetaJobData> => service),
          ),
        ),
        TE.bind('workerService', () =>
          pipe(
            createWorkerService<MetaJobData>(
              queueName,
              queueConfig,
              async (job: Job<MetaJobData>) => {
                processedJobs.push(job.name as JobName);
                jobsProcessed++;
              },
              { concurrency: 1 },
            ),
            TE.map((service): WorkerService<MetaJobData> => service),
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            workerService.start(),
            TE.chain(() => queueService.addJob(createTestMetaJobData({ name: defaultJobName }))),
            TE.chain(() => queueService.addJob(createTestMetaJobData({ name: defaultJobName }))),
            TE.chain(() =>
              TE.tryCatch(
                async () => {
                  await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => {
                      reject(new Error('Jobs were not processed within the expected timeframe'));
                    }, 5000);

                    const checkComplete = () => {
                      if (jobsProcessed === 2) {
                        clearTimeout(timeout);
                        resolve();
                      }
                    };

                    // Check immediately
                    checkComplete();
                    // Set up completion listener
                    workerService.getWorker().on('completed', checkComplete);
                  });
                },
                (error) => error as QueueError,
              ),
            ),
            TE.chain(() => workerService.close()),
            TE.chain(() => queueService.obliterate()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs).toHaveLength(2);
      expect(processedJobs[0]).toBe(defaultJobName);
      expect(processedJobs[1]).toBe(defaultJobName);
    }, 30000);

    test('should pause and resume worker', async () => {
      const result = await pipe(
        createWorkerService<MetaJobData>(
          queueName,
          queueConfig,
          async () => {
            // Empty processor
          },
          { concurrency: 1 },
        ),
        TE.map((service): WorkerService<MetaJobData> => service),
        TE.chain((service) =>
          pipe(
            service.pause(),
            TE.chain(() => service.resume()),
            TE.chain(() => service.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should set concurrency', async () => {
      const result = await pipe(
        createWorkerService<MetaJobData>(
          queueName,
          queueConfig,
          async () => {
            // Empty processor
          },
          { concurrency: 1 },
        ),
        TE.map((service): WorkerService<MetaJobData> => service),
        TE.chain((service) => {
          service.setConcurrency(2);
          return service.close();
        }),
      )();

      expect(result._tag).toBe('Right');
    });
  });

  // Cleanup after each test
  afterEach(async () => {
    const cleanup = await pipe(
      createQueueServiceImpl<MetaJobData>(queueName, queueConfig),
      TE.map((service): QueueService<MetaJobData> => service),
      TE.chain((service) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });
});
