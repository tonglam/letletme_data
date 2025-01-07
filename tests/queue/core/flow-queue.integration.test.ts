import { config } from 'dotenv';
config();

import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createFlowService } from '../../../src/infrastructure/queue/core/flow.service';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { FlowOpts, QueueService, WorkerService } from '../../../src/infrastructure/queue/types';
import { QueueError } from '../../../src/types/error.type';
import { JobName, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData, createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Flow Queue Integration Tests', () => {
  const queueName = 'test-flow-queue';
  const defaultJobName: JobName = 'meta';
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
    // Add delay after cleanup
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  afterEach(async () => {
    const cleanup = await pipe(
      createQueueServiceImpl<MetaJobData>(queueName, config),
      TE.chain((service: QueueService<MetaJobData>) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });

  describe('Flow Queue Integration', () => {
    test('should process flow jobs in correct order', async () => {
      const processedJobs: MetaJobData[] = [];
      let checkInterval: NodeJS.Timeout;

      const jobProcessed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Job processing timeout'));
        }, 30000);

        checkInterval = setInterval(() => {
          if (processedJobs.length === 3) {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
          }
        }, 1000);
      });

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<MetaJobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<MetaJobData>(
            queueName,
            config,
            async (job: Job<MetaJobData>) => {
              console.log(`Processing job ${job.id} with data:`, job.data);
              await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate work
              processedJobs.push(job.data);
              console.log(`Job ${job.id} processed successfully`);
            },
            { concurrency: 1 },
          ),
        ),
        TE.chain(({ queueService, workerService }) => {
          const flowService = createFlowService<MetaJobData>(
            queueService.getQueue(),
            defaultJobName,
          );
          return pipe(
            TE.tryCatch(
              async () => {
                await flowService.addJob(createTestMetaJobData({ name: defaultJobName }), {
                  jobId: 'parent-job',
                  children: [
                    {
                      name: defaultJobName,
                      queueName,
                      data: createTestMetaJobData({ name: defaultJobName }),
                      opts: { jobId: 'child-1' },
                    },
                    {
                      name: defaultJobName,
                      queueName,
                      data: createTestMetaJobData({ name: defaultJobName }),
                      opts: { jobId: 'child-2' },
                    },
                  ],
                } as FlowOpts<MetaJobData>)();
                await jobProcessed;
                await flowService.close();
              },
              (error) => error as QueueError,
            ),
            TE.chain(() => workerService.close()),
          );
        }),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(3);
    }, 40000);

    test('should handle flow job failure', async () => {
      const queueServiceE = await createQueueServiceImpl<MetaJobData>(queueName, config)();
      expect(queueServiceE._tag).toBe('Right');

      if (queueServiceE._tag === 'Right') {
        const queueService = queueServiceE.right;
        let workerService: WorkerService<MetaJobData>;

        const workerServiceE = await createWorkerService<MetaJobData>(
          queueName,
          config,
          async (job: Job<MetaJobData>) => {
            console.log(`Processing attempt ${job.attemptsMade + 1}`);

            if (job.attemptsMade === 0) {
              console.log('First attempt failing');
              throw new Error('Simulated failure');
            }

            console.log('Second attempt succeeding');
            return;
          },
          {
            concurrency: 1,
          },
        )();

        expect(workerServiceE._tag).toBe('Right');
        if (workerServiceE._tag === 'Right') {
          workerService = workerServiceE.right;
          const worker = workerService.getWorker();

          worker.on('completed', (job) => {
            if (job) {
              console.log(`Job completed with attempts: ${job.attemptsMade + 1}`);
            }
          });

          worker.on('failed', (job) => {
            if (job) {
              console.log(`Job failed on attempt: ${job.attemptsMade + 1}`);
            }
          });

          const flowService = createFlowService<MetaJobData>(
            queueService.getQueue(),
            defaultJobName,
          );

          try {
            const addResult = await flowService.addJob(
              createTestMetaJobData({ name: defaultJobName }),
              {
                jobId: 'retry-test-job',
                attempts: 2,
                backoff: {
                  type: 'fixed',
                  delay: 100,
                },
                removeOnComplete: false,
                removeOnFail: false,
              } as FlowOpts<MetaJobData>,
            )();

            expect(addResult._tag).toBe('Right');

            // Wait for job to complete or fail
            let job = await queueService.getQueue().getJob('retry-test-job');
            let state = await job?.getState();
            const startTime = Date.now();
            let lastAttempts = job?.attemptsMade ?? 0;
            let stableCount = 0;

            while (state !== 'completed' && Date.now() - startTime < 15000) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              job = await queueService.getQueue().getJob('retry-test-job');
              state = await job?.getState();

              // Check if attempts have stabilized
              if (job && job.attemptsMade === lastAttempts) {
                stableCount++;
              } else if (job) {
                lastAttempts = job.attemptsMade;
                stableCount = 0;
              }

              // If attempts have been stable for a while, break
              if (stableCount > 10) {
                break;
              }
            }

            expect(job?.attemptsMade).toBe(1);
            expect(state).toBe('completed');

            await flowService.close();
            await workerService.close();
          } catch (error) {
            await flowService.close();
            await workerService.close();
            throw error;
          }
        }
      }
    }, 20000);

    test('should get flow dependencies', async () => {
      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueServiceImpl<MetaJobData>(queueName, config)),
        TE.chain(({ queueService }) => {
          const flowService = createFlowService<MetaJobData>(
            queueService.getQueue(),
            defaultJobName,
          );
          return pipe(
            TE.tryCatch(
              async () => {
                const addResult = await flowService.addJob(
                  createTestMetaJobData({ name: defaultJobName }),
                  {
                    jobId: 'parent-job',
                    children: [
                      {
                        name: defaultJobName,
                        queueName,
                        data: createTestMetaJobData({ name: defaultJobName }),
                        opts: { jobId: 'child-1' },
                      },
                    ],
                  } as FlowOpts<MetaJobData>,
                )();

                if (addResult._tag === 'Left') {
                  throw addResult.left;
                }

                // Wait for jobs to be added
                await new Promise((resolve) => setTimeout(resolve, 1000));
                const dependenciesE = await flowService.getFlowDependencies('child-1')();
                await flowService.close();

                if (E.isLeft(dependenciesE)) {
                  throw dependenciesE.left;
                }
                return dependenciesE.right;
              },
              (error) => error as QueueError,
            ),
          );
        }),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right.length).toBe(1);
      }
    }, 40000);
  });
});
