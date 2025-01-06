import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueService } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueError } from '../../../src/types/errors.type';
import { JobName, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData, createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Worker Service Tests', () => {
  const queueName = 'test-worker-queue';
  const defaultJobName = 'meta' as JobName;
  const config = createTestQueueConfig();

  // Cleanup before each test to ensure a clean state
  beforeEach(async () => {
    const cleanup = await pipe(
      createQueueService<MetaJobData>(queueName, config),
      TE.chain((service) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });

  describe('Core Operations', () => {
    test('should create worker service', async () => {
      const result = await pipe(
        createWorkerService<MetaJobData>(queueName, config, async () => {
          // Process job
        }),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const service = result.right;
        await service.stop()();
        await service.close()();
      }
    });

    test('should start and stop worker', async () => {
      const result = await pipe(
        createWorkerService<MetaJobData>(queueName, config, async () => {
          // Process job
        }),
        TE.chain((service) =>
          pipe(
            TE.tryCatch(
              async () => {
                const w = service.getWorker();
                // Worker should be running since it auto-runs
                const initialState = await w.isPaused();
                console.log('Initial state:', initialState);
                expect(initialState).toBe(false);

                // Stop the worker
                await service.stop()();
                await new Promise((resolve) => setTimeout(resolve, 100));
                const stoppedState = await w.isPaused();
                console.log('Stopped state:', stoppedState);
                expect(stoppedState).toBe(true);

                // Cleanup
                await service.close()();
              },
              (error) => {
                console.error('Error in worker test:', error);
                return error as QueueError;
              },
            ),
          ),
        ),
      )();

      if (result._tag === 'Left') {
        console.error('Test failed with error:', result.left);
      }
      expect(result._tag).toBe('Right');
    }, 5000);

    test('should pause and resume worker', async () => {
      const result = await pipe(
        createWorkerService<MetaJobData>(queueName, config, async () => {
          // Process job
        }),
        TE.chain((service) =>
          pipe(
            TE.tryCatch(
              async () => {
                const w = service.getWorker();
                // Worker should be running since it auto-runs
                expect(await w.isPaused()).toBe(false);

                // Pause the worker
                await service.pause()();
                expect(await w.isPaused()).toBe(true);

                // Resume the worker
                await service.resume()();
                expect(await w.isPaused()).toBe(false);

                // Cleanup
                await service.close()();
              },
              (error) => error as QueueError,
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    }, 30000);
  });

  describe('Job Processing', () => {
    test('should process job successfully', async () => {
      const processedJobs: MetaJobData[] = [];

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<MetaJobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(queueName, config, async (job: Job<MetaJobData>) => {
            processedJobs.push(job.data);
          }),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                // Add a job
                await queueService.addJob(createTestMetaJobData({ name: defaultJobName }))();

                // Wait for job to be processed
                await new Promise<void>((resolve, reject) => {
                  const timeout = setTimeout(() => {
                    reject(new Error('Job processing timeout'));
                  }, 10000);

                  const checkProcessed = () => {
                    if (processedJobs.length > 0) {
                      clearTimeout(timeout);
                      resolve();
                    } else {
                      setTimeout(checkProcessed, 500);
                    }
                  };
                  checkProcessed();
                });

                // Cleanup
                await workerService.close()();
                await queueService.obliterate()();
              },
              (error) => error as QueueError,
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(1);
      expect(processedJobs[0].type).toBe('META');
    }, 30000);

    test('should handle job failure', async () => {
      let attempts = 0;
      let jobProcessed = false;

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<MetaJobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(queueName, config, async () => {
            attempts++;
            console.log('Processing attempt:', attempts);
            if (attempts <= 2) {
              console.log('Simulating failure on attempt:', attempts);
              throw new Error('Simulated job failure');
            }
            console.log('Job processed successfully on attempt:', attempts);
            jobProcessed = true;
          }),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            TE.tryCatch(
              async () => {
                console.log('Adding job to queue');
                // Add a job with retry settings
                await queueService.addJob(createTestMetaJobData({ name: defaultJobName }), {
                  attempts: 3,
                  backoff: {
                    type: 'fixed',
                    delay: 1000,
                  },
                })();

                // Wait for job to be processed or fail
                await new Promise<void>((resolve, reject) => {
                  const timeout = setTimeout(() => {
                    console.log(
                      'Job processing timed out. Attempts:',
                      attempts,
                      'Processed:',
                      jobProcessed,
                    );
                    reject(new Error('Job processing timeout'));
                  }, 20000);

                  const checkProcessed = () => {
                    console.log(
                      'Checking job status. Attempts:',
                      attempts,
                      'Processed:',
                      jobProcessed,
                    );
                    if (jobProcessed || attempts >= 3) {
                      console.log('Job completed. Attempts:', attempts, 'Processed:', jobProcessed);
                      clearTimeout(timeout);
                      resolve();
                    } else {
                      setTimeout(checkProcessed, 1000);
                    }
                  };
                  checkProcessed();
                });

                console.log('Cleaning up');
                // Cleanup
                await workerService.close()();
                await queueService.obliterate()();
              },
              (error) => {
                console.error('Error in job failure test:', error);
                return error as QueueError;
              },
            ),
          ),
        ),
      )();

      if (result._tag === 'Left') {
        console.error('Test failed with error:', result.left);
      }
      expect(result._tag).toBe('Right');
      expect(attempts).toBeGreaterThanOrEqual(3);
      expect(jobProcessed).toBe(true);
    }, 30000);
  });

  // Cleanup after each test
  afterEach(async () => {
    const cleanup = await pipe(
      createQueueService<MetaJobData>(queueName, config),
      TE.chain((service) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });
});
