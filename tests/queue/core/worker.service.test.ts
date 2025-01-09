import { config } from 'dotenv';
config();

import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { closeConnections, initializeConnections } from '../../../src/config/queue/queue.config';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService, WorkerService } from '../../../src/infrastructure/queue/types';
import { createQueueError, QueueErrorCode } from '../../../src/types/error.type';
import { JobData, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData } from '../../utils/queue.test.utils';

describe('Worker Service Tests', () => {
  // Validate Redis configuration
  beforeAll(async () => {
    if (!process.env.REDIS_HOST) {
      throw new Error('Redis host is missing. Please check your .env file.');
    }
    await initializeConnections();
  });

  afterAll(async () => {
    await closeConnections();
  });

  const queueName = 'test-worker-queue';
  let queueService: QueueService<JobData>;
  let workerService: WorkerService<JobData>;

  beforeEach(async () => {
    const queueResult = await createQueueServiceImpl<JobData>(queueName)();
    if (queueResult._tag === 'Left') throw queueResult.left;
    queueService = queueResult.right;
  });

  afterEach(async () => {
    if (workerService) {
      const closeResult = await workerService.close()();
      expect(closeResult._tag).toBe('Right');
    }
    const cleanupResult = await queueService.obliterate()();
    expect(cleanupResult._tag).toBe('Right');
    // Add a small delay to ensure Redis connections are properly closed
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  describe('Core Operations', () => {
    test('should create worker with configuration', async () => {
      const processor = async (job: Job<MetaJobData>) => {
        expect(job.data).toBeDefined();
      };

      const result = await createWorkerService<JobData>(queueName, processor)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        workerService = result.right;
        const worker = workerService.getWorker();
        expect(worker).toBeDefined();
        expect(worker.name).toBe(queueName);
      }
    });

    test('should process job successfully', async () => {
      let processedJobId: string | undefined;
      const processor = async (job: Job<MetaJobData>) => {
        // Validate job data
        expect(job.data.type).toBe('META');
        expect(job.data.name).toBe('meta');
        expect(job.data.data.operation).toBe('SYNC');
        expect(job.data.data.metaType).toBe('EVENTS');
        processedJobId = job.id;
      };

      const result = await pipe(
        createWorkerService<JobData>(queueName, processor),
        TE.chain((service) => {
          workerService = service;
          // Wait for worker to be ready and start processing
          return pipe(
            service.start(),
            TE.chain(() =>
              TE.tryCatch(
                async () => {
                  // Wait for worker to be ready and start processing
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  const jobData = createTestMetaJobData({
                    operation: 'SYNC',
                    metaType: 'EVENTS',
                    name: 'meta',
                  });
                  const job = await queueService.addJob(jobData)();
                  if (job._tag === 'Left') throw job.left;
                  return queueName;
                },
                (error) => createQueueError(QueueErrorCode.START_WORKER, queueName, error as Error),
              ),
            ),
          );
        }),
      )();

      expect(result._tag).toBe('Right');

      // Wait for job processing with a longer timeout
      await new Promise<void>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (processedJobId) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 100);

        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Job processing timeout'));
        }, 15000); // Increased timeout
      });

      expect(processedJobId).toBeDefined();
    }, 20000); // Increased test timeout

    test('should handle concurrent jobs', async () => {
      const processedJobs = new Set<string>();
      const processor = async (job: Job<MetaJobData>) => {
        // Validate job data
        expect(job.data.type).toBe('META');
        expect(job.data.name).toBe('meta');
        expect(job.data.data.operation).toBe('SYNC');
        expect(job.data.data.metaType).toBe('EVENTS');
        await new Promise((resolve) => setTimeout(resolve, 100)); // Simulate work
        processedJobs.add(job.id as string);
      };

      const result = await pipe(
        createWorkerService<JobData>(queueName, processor, { concurrency: 3 }),
        TE.chain((service) => {
          workerService = service;
          // Wait for worker to be ready and start processing
          return pipe(
            service.start(),
            TE.chain(() =>
              TE.tryCatch(
                async () => {
                  // Wait for worker to be ready and start processing
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  const jobs = Array.from({ length: 5 }, () =>
                    createTestMetaJobData({
                      operation: 'SYNC',
                      metaType: 'EVENTS',
                      name: 'meta',
                    }),
                  );
                  const result = await queueService.addBulk(jobs.map((data) => ({ data })))();
                  if (result._tag === 'Left') throw result.left;
                  return queueName;
                },
                (error) => createQueueError(QueueErrorCode.START_WORKER, queueName, error as Error),
              ),
            ),
          );
        }),
      )();

      expect(result._tag).toBe('Right');

      // Wait for all jobs to complete with a longer timeout
      await new Promise<void>((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (processedJobs.size === 5) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 100);

        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error(`Only processed ${processedJobs.size} of 5 jobs`));
        }, 20000); // Increased timeout
      });

      expect(processedJobs.size).toBe(5);
    }, 25000); // Increased test timeout

    test('should pause and resume worker', async () => {
      const processor = async (job: Job<MetaJobData>) => {
        expect(job.data).toBeDefined();
      };

      const result = await pipe(
        createWorkerService<JobData>(queueName, processor),
        TE.chain((service) => {
          workerService = service;
          return pipe(
            service.pause(),
            TE.chain(() => service.resume()),
          );
        }),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should update concurrency', async () => {
      const processor = async (job: Job<MetaJobData>) => {
        expect(job.data).toBeDefined();
      };

      const result = await createWorkerService<JobData>(queueName, processor, { concurrency: 5 })();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        workerService = result.right;
        expect(workerService.getWorker().opts.concurrency).toBe(5);
      }
    });
  });

  describe('Error Handling', () => {
    test('should handle job processing failure', async () => {
      const errorMessage = 'Test processing error';
      const processor = async () => {
        throw new Error(errorMessage);
      };

      const result = await pipe(
        createWorkerService<JobData>(queueName, processor),
        TE.chain((service) => {
          workerService = service;
          return queueService.addJob(createTestMetaJobData());
        }),
      )();

      expect(result._tag).toBe('Right');
      // Wait for job processing
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    test('should handle force pause', async () => {
      const processor = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000)); // Long running job
      };

      const result = await pipe(
        createWorkerService<JobData>(queueName, processor),
        TE.chain((service) => {
          workerService = service;
          return pipe(
            queueService.addJob(createTestMetaJobData()),
            TE.chain(() => service.pause(true)), // Force pause
          );
        }),
      )();

      expect(result._tag).toBe('Right');
    });
  });
});
