import { config } from 'dotenv';
config();

import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService } from '../../../src/infrastructure/queue/types';
import { QueueError } from '../../../src/types/errors.type';
import { JobData, JobName } from '../../../src/types/job.type';
import { createTestMetaJobData, createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Queue-Worker Integration Tests', () => {
  const queueName = 'test-worker-queue';
  const defaultJobName = 'meta' as JobName;
  const config = createTestQueueConfig();

  // Validate Redis configuration
  beforeAll(() => {
    if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD) {
      throw new Error('Redis configuration is missing. Please check your .env file.');
    }
  });

  const createTestJob = (): JobData => createTestMetaJobData({ name: defaultJobName });

  // Cleanup before and after each test
  beforeEach(async () => {
    const cleanup = await pipe(
      createQueueServiceImpl<JobData>(queueName, config),
      TE.chain((service: QueueService<JobData>) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });

  afterEach(async () => {
    const cleanup = await pipe(
      createQueueServiceImpl<JobData>(queueName, config),
      TE.chain((service: QueueService<JobData>) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });

  describe('End-to-End Job Processing', () => {
    test('should process job successfully', async () => {
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(
            new Error(
              'Job processing timeout - job was not processed within the expected timeframe',
            ),
          );
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
        TE.bind('queueService', () => createQueueServiceImpl<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              console.log(`Processing job ${job.id} with data:`, job.data);
              processedJobs.push(job.data);
              console.log(`Job ${job.id} processed successfully`);
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.right(undefined),
            TE.chain(() => {
              console.log('Adding job to queue');
              return queueService.addJob(createTestJob());
            }),
            TE.chain(() => {
              console.log('Job added to queue successfully');
              return TE.tryCatch(
                () => jobProcessed,
                (error) => {
                  console.error('Error during job processing:', error);
                  return error as QueueError;
                },
              );
            }),
            TE.chain(() => workerService.close()),
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
      let checkInterval: NodeJS.Timeout;

      const jobsProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(
            new Error(
              'Jobs processing timeout - jobs were not processed within the expected timeframe',
            ),
          );
        }, 20000);

        checkInterval = setInterval(() => {
          if (processedJobs.length === 5) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              console.log(`Processing job ${job.id} with data:`, job.data);
              await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate work
              processedJobs.push(job.data);
              console.log(`Job ${job.id} processed successfully`);
            },
            { concurrency },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.right(undefined),
            TE.chain(() => {
              console.log('Adding jobs to queue');
              return queueService.addBulk(
                Array.from({ length: 5 }, () => ({
                  data: createTestJob(),
                })),
              );
            }),
            TE.chain(() => {
              console.log('Jobs added to queue successfully');
              return TE.tryCatch(
                () => jobsProcessed,
                (error) => {
                  console.error('Error during jobs processing:', error);
                  return error as QueueError;
                },
              );
            }),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(5);
    }, 30000);

    test('should handle job failure and retry', async () => {
      let attempts = 0;
      let checkInterval: NodeJS.Timeout;

      const jobAttempted = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Job retry timeout - job did not retry within the expected timeframe'));
        }, 20000);

        checkInterval = setInterval(() => {
          if (attempts === 2) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 500);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              console.log(`Processing job ${job.id}, attempt ${attempts + 1}`);
              attempts++;
              if (attempts === 1) {
                console.log(`Job ${job.id} failed on first attempt`);
                throw new Error('Simulated failure');
              }
              console.log(`Job ${job.id} processed successfully on attempt ${attempts}`);
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.right(undefined),
            TE.chain(() => {
              console.log('Adding job to queue');
              return queueService.addJob(createTestJob(), {
                jobId: 'retry-test-job',
                delay: 0,
                repeat: {
                  every: 1000,
                  limit: 2,
                },
              });
            }),
            TE.chain(() => {
              console.log('Job added to queue successfully');
              return TE.tryCatch(
                () => jobAttempted,
                (error) => {
                  console.error('Error during job retry:', error);
                  return error as QueueError;
                },
              );
            }),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(attempts).toBe(2);
    }, 30000);

    test('should handle worker recovery after disconnection', async () => {
      const processedJobs: JobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Job processing timeout - job was not processed after worker recovery'));
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
        TE.bind('queueService', () => createQueueServiceImpl<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              console.log(`Processing job ${job.id} with data:`, job.data);
              processedJobs.push(job.data);
              console.log(`Job ${job.id} processed successfully`);
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            workerService.close(),
            TE.chain(() => {
              console.log('First worker closed successfully');
              return createWorkerService<JobData>(
                queueName,
                config,
                async (job: Job<JobData>) => {
                  console.log(`Processing job ${job.id} with data:`, job.data);
                  processedJobs.push(job.data);
                  console.log(`Job ${job.id} processed successfully`);
                },
                { concurrency: 1 },
              );
            }),
            TE.chain((newWorker) =>
              pipe(
                TE.right(undefined),
                TE.chain(() => {
                  console.log('Adding job to queue');
                  return queueService.addJob(createTestJob(), {
                    jobId: 'recovery-test-job',
                  });
                }),
                TE.chain(() => {
                  console.log('Job added to queue successfully');
                  return TE.tryCatch(
                    () => jobProcessed,
                    (error) => {
                      console.error('Error during job processing after recovery:', error);
                      return error as QueueError;
                    },
                  );
                }),
                TE.chain(() => newWorker.close()),
              ),
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(1);
    }, 30000);

    test('should process jobs with worker', async () => {
      const jobData = createTestMetaJobData({ name: defaultJobName });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(
            queueName,
            config,
            async (job: Job<JobData>) => {
              expect(job.data).toEqual(jobData);
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            queueService.addJob(jobData),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });
  });
});
