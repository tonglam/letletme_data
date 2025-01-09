import { config } from 'dotenv';
config({ path: '.env' });

import { Job, RateLimiterOptions, WorkerOptions } from 'bullmq';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QUEUE_CONFIG } from '../../../src/config/queue/queue.config';
import { redisClient } from '../../../src/infrastructure/cache/client';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService, WorkerService } from '../../../src/infrastructure/queue/types';
import {
  createMetaJobData,
  createMetaJobProcessor,
  MetaJobProcessor,
} from '../../../src/queue/meta/meta.queue';
import { createQueueError, QueueErrorCode } from '../../../src/types/error.type';
import { MetaJobData, MetaService, MetaType } from '../../../src/types/job.type';

describe('meta.queue', () => {
  const TEST_TIMEOUT = 120000;
  const TEST_QUEUE_NAME = 'meta';
  let sharedQueueService: QueueService<MetaJobData>;
  let sharedWorkerService: WorkerService<MetaJobData>;

  const mockMetaService: MetaService = {
    syncMeta: () => TE.right(undefined),
  };

  const mockJob: Job<MetaJobData> = {
    data: createMetaJobData('SYNC', 'EVENTS'),
  } as Job<MetaJobData>;

  const mockProcessor: Partial<Record<MetaType, MetaJobProcessor>> = {
    EVENTS: () => TE.right(undefined),
  };

  const cleanupFunctions: Array<() => Promise<void>> = [];

  const workerOptions: WorkerOptions = {
    concurrency: 1,
    connection: {
      host: QUEUE_CONFIG.REDIS.HOST,
      port: QUEUE_CONFIG.REDIS.PORT,
      password: QUEUE_CONFIG.REDIS.PASSWORD,
    },
  };

  const rateLimitedWorkerOptions: WorkerOptions = {
    ...workerOptions,
    limiter: {
      max: QUEUE_CONFIG.RATE_LIMIT.MAX,
      duration: QUEUE_CONFIG.RATE_LIMIT.DURATION,
    } satisfies RateLimiterOptions,
  };

  const setupWorker = async (
    options: WorkerOptions = workerOptions,
  ): Promise<WorkerService<MetaJobData>> => {
    console.log('Setting up worker with options:', options);
    const workerServiceResult = await createWorkerService<MetaJobData>(
      TEST_QUEUE_NAME,
      async (job: Job<MetaJobData>) => {
        console.log('Worker processor called with job:', job.id);
        const result = await createMetaJobProcessor(mockProcessor)(job, mockMetaService)();
        if (E.isLeft(result)) {
          console.error('Worker processor error:', result.left);
          throw result.left;
        }
        return result.right;
      },
      options,
    )();

    if (E.isLeft(workerServiceResult)) {
      console.error('Failed to create worker service:', workerServiceResult.left);
      throw workerServiceResult.left;
    }

    const workerService = workerServiceResult.right;
    console.log('Worker service created');

    // Start the worker and wait for it to be ready
    await workerService.start()();

    // Add a small delay to ensure the worker is fully initialized
    await new Promise((resolve) => setTimeout(resolve, 1000));

    return workerService;
  };

  const cleanupQueue = async () => {
    // Execute all cleanup functions in parallel
    await Promise.all(cleanupFunctions.map((cleanup) => cleanup()));
    cleanupFunctions.length = 0;

    try {
      if (!sharedQueueService) {
        const queueServiceResult = await createQueueServiceImpl<MetaJobData>(TEST_QUEUE_NAME)();
        if (E.isLeft(queueServiceResult)) {
          throw queueServiceResult.left;
        }
        sharedQueueService = queueServiceResult.right;
      }

      // Clean all job types in parallel
      await Promise.all([
        sharedQueueService.clean(0, 1000, 'completed')(),
        sharedQueueService.clean(0, 1000, 'failed')(),
        sharedQueueService.clean(0, 1000, 'active')(),
        sharedQueueService.clean(0, 1000, 'delayed')(),
        sharedQueueService.clean(0, 1000, 'wait')(),
      ]);

      // Drain and obliterate
      await sharedQueueService.drain()();
      await sharedQueueService.obliterate()();
    } catch (error) {
      console.error('Error in cleanup:', error);
      throw error;
    }
  };

  beforeAll(async () => {
    try {
      // Validate Redis configuration
      if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD) {
        throw new Error('Redis configuration is missing. Please check your .env file.');
      }
      console.log('Redis config:', {
        host: QUEUE_CONFIG.REDIS.HOST,
        port: QUEUE_CONFIG.REDIS.PORT,
      });

      // Create shared queue service
      const queueServiceResult = await createQueueServiceImpl<MetaJobData>(TEST_QUEUE_NAME)();
      if (E.isLeft(queueServiceResult)) {
        console.error('Failed to create queue service:', queueServiceResult.left);
        throw queueServiceResult.left;
      }
      sharedQueueService = queueServiceResult.right;
      console.log('Queue service created successfully');

      // Create shared worker service
      sharedWorkerService = await setupWorker();
      console.log('Worker service created successfully');

      await cleanupQueue();
      console.log('Queue cleanup completed');
    } catch (error) {
      console.error('Error in beforeAll:', error);
      throw error;
    }
  }, TEST_TIMEOUT);

  afterEach(async () => {
    try {
      await cleanupQueue();
    } catch (error) {
      console.error('Error in afterEach:', error);
      throw error;
    }
  });

  afterAll(async () => {
    try {
      await cleanupQueue();
      if (sharedWorkerService) {
        await sharedWorkerService.close()();
      }
      if (sharedQueueService) {
        await sharedQueueService.close()();
      }
      await redisClient.quit();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  describe('createMetaJobData', () => {
    it('should create valid meta job data with SYNC operation', () => {
      const jobData = createMetaJobData('SYNC', 'EVENTS');
      expect(jobData.type).toBe('META');
      expect(jobData.name).toBe('meta');
      expect(jobData.data.operation).toBe('SYNC');
      expect(jobData.data.metaType).toBe('EVENTS');
      expect(jobData.timestamp).toBeInstanceOf(Date);
    });

    it('should create job data with current timestamp', () => {
      const before = new Date();
      const jobData = createMetaJobData('SYNC', 'EVENTS');
      const after = new Date();
      expect(jobData.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(jobData.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('createMetaJobProcessor', () => {
    it('should process job with valid processor', async () => {
      const processor = createMetaJobProcessor(mockProcessor);
      const result = await processor(mockJob, mockMetaService)();
      expect(E.isRight(result)).toBeTruthy();
    });

    it('should handle missing processor error', async () => {
      const processor = createMetaJobProcessor({});
      const result = await processor(mockJob, mockMetaService)();
      expect(E.isLeft(result)).toBeTruthy();
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(QueueErrorCode.PROCESSING_ERROR);
        expect(result.left.context).toBe('meta');
      }
    });

    it('should handle processor execution error', async () => {
      const error = new Error('Processor error');
      const failingProcessor: Partial<Record<MetaType, MetaJobProcessor>> = {
        EVENTS: () => TE.left(createQueueError(QueueErrorCode.PROCESSING_ERROR, 'meta', error)),
      };
      const processor = createMetaJobProcessor(failingProcessor);
      const result = await processor(mockJob, mockMetaService)();
      expect(E.isLeft(result)).toBeTruthy();
      if (E.isLeft(result)) {
        expect(result.left.code).toBe(QueueErrorCode.PROCESSING_ERROR);
        expect(result.left.context).toBe('meta');
      }
    });
  });

  describe('createMetaQueueService', () => {
    it('should create meta queue service with correct worker options', async () => {
      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<MetaJobData>(TEST_QUEUE_NAME)),
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(
            TEST_QUEUE_NAME,
            async (job: Job<MetaJobData>) => {
              const result = await createMetaJobProcessor(mockProcessor)(job, mockMetaService)();
              if (E.isLeft(result)) {
                throw result.left;
              }
              return result.right;
            },
            workerOptions,
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          TE.tryCatch(
            async () => {
              await workerService.start()();
              await new Promise((resolve) => setTimeout(resolve, 1000));
              cleanupFunctions.push(async () => {
                const closeResult = await workerService.close()();
                if (E.isLeft(closeResult)) {
                  throw closeResult.left;
                }
              });
              return { queueService, workerService };
            },
            (error) => createQueueError(QueueErrorCode.CREATE_WORKER, 'meta', error as Error),
          ),
        ),
      )();

      expect(E.isRight(result)).toBeTruthy();
    });

    it('should handle job retries with backoff', async () => {
      const retryProcessor: Partial<Record<MetaType, MetaJobProcessor>> = {
        EVENTS: () =>
          TE.left(
            createQueueError(QueueErrorCode.PROCESSING_ERROR, 'meta', new Error('First attempt')),
          ),
      };

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<MetaJobData>(TEST_QUEUE_NAME)),
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(
            TEST_QUEUE_NAME,
            async (job: Job<MetaJobData>) => {
              const result = await createMetaJobProcessor(retryProcessor)(job, mockMetaService)();
              if (E.isLeft(result)) {
                throw result.left;
              }
              return result.right;
            },
            workerOptions,
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          TE.tryCatch(
            async () => {
              await workerService.start()();
              await new Promise((resolve) => setTimeout(resolve, 1000));
              await queueService.addJob(mockJob.data, {
                attempts: 2,
                backoff: {
                  type: 'exponential',
                  delay: 100,
                },
              })();

              // Wait for job to be processed and retried
              await new Promise((resolve) => setTimeout(resolve, 300));

              cleanupFunctions.push(async () => {
                const closeResult = await workerService.close()();
                if (E.isLeft(closeResult)) {
                  throw closeResult.left;
                }
              });
              return { queueService, workerService };
            },
            (error) => createQueueError(QueueErrorCode.CREATE_WORKER, 'meta', error as Error),
          ),
        ),
      )();

      expect(E.isRight(result)).toBeTruthy();
    });

    it('should handle pause and resume operations', async () => {
      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<MetaJobData>(TEST_QUEUE_NAME)),
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(
            TEST_QUEUE_NAME,
            async (job: Job<MetaJobData>) => {
              const result = await createMetaJobProcessor(mockProcessor)(job, mockMetaService)();
              if (E.isLeft(result)) {
                throw result.left;
              }
              return result.right;
            },
            workerOptions,
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          TE.tryCatch(
            async () => {
              await workerService.start()();
              await new Promise((resolve) => setTimeout(resolve, 1000));

              // Test pause
              await workerService.pause(true)();
              await queueService.pause()();
              expect(await workerService.getWorker().isPaused()).toBeTruthy();

              // Test resume
              await queueService.resume()();
              await workerService.resume()();
              expect(await workerService.getWorker().isPaused()).toBeFalsy();

              // Verify processing works after resume
              const addJobResult = await queueService.addJob(mockJob.data)();
              expect(E.isRight(addJobResult)).toBeTruthy();

              // Wait for job to be processed
              await new Promise((resolve) => setTimeout(resolve, 500));

              cleanupFunctions.push(async () => {
                const closeResult = await workerService.close()();
                if (E.isLeft(closeResult)) {
                  throw closeResult.left;
                }
              });

              return { queueService, workerService };
            },
            (error) => createQueueError(QueueErrorCode.CREATE_WORKER, 'meta', error as Error),
          ),
        ),
      )();

      expect(E.isRight(result)).toBeTruthy();
    });

    it('should handle rate limiting', async () => {
      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<MetaJobData>(TEST_QUEUE_NAME)),
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(
            TEST_QUEUE_NAME,
            async (job: Job<MetaJobData>) => {
              const result = await createMetaJobProcessor(mockProcessor)(job, mockMetaService)();
              if (E.isLeft(result)) {
                throw result.left;
              }
              return result.right;
            },
            rateLimitedWorkerOptions,
          ),
        ),
        TE.chain(({ queueService, workerService }) =>
          TE.tryCatch(
            async () => {
              await workerService.start()();
              await new Promise((resolve) => setTimeout(resolve, 1000));

              const startTime = Date.now();

              // Add jobs in parallel
              const jobCount = QUEUE_CONFIG.RATE_LIMIT.MAX * 2;
              await Promise.all(
                Array.from({ length: jobCount }).map(() => queueService.addJob(mockJob.data)()),
              );

              // Wait for rate limit duration
              await new Promise((resolve) =>
                setTimeout(resolve, QUEUE_CONFIG.RATE_LIMIT.DURATION / 2),
              );

              const duration = Date.now() - startTime;
              expect(duration).toBeGreaterThanOrEqual(QUEUE_CONFIG.RATE_LIMIT.DURATION / 2);

              cleanupFunctions.push(async () => {
                const closeResult = await workerService.close()();
                if (E.isLeft(closeResult)) {
                  throw closeResult.left;
                }
              });

              return { queueService, workerService };
            },
            (error) => createQueueError(QueueErrorCode.CREATE_WORKER, 'meta', error as Error),
          ),
        ),
      )();

      expect(E.isRight(result)).toBeTruthy();
    });
  });
});
