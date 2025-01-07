import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createFlowService } from '../../../src/infrastructure/queue/core/flow.service';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueError } from '../../../src/types/error.type';
import { JobData, JobName, MetaType } from '../../../src/types/job.type';
import { createTestMetaJobData } from '../../utils/queue.test.utils';

describe('Queue Performance Tests', () => {
  const queueName = 'test-queue';
  const defaultJobName = 'meta' as JobName;
  const config = {
    connection: {
      host: 'localhost',
      port: 6379,
    },
  };

  beforeEach(async () => {
    const queueServiceE = await createQueueServiceImpl<JobData>(queueName, config)();
    if (E.isRight(queueServiceE)) {
      await queueServiceE.right.drain()();
    }
  });

  it('should handle high-volume job processing', async () => {
    const jobCount = 100;
    const processedJobs = new Set<string>();
    const jobsProcessed = new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        console.log('Current processed jobs:', processedJobs.size);
        if (processedJobs.size === jobCount) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkInterval);
        console.error('Processed jobs:', processedJobs.size);
        console.error('Expected jobs:', jobCount);
        reject(new Error('High-volume job processing timeout'));
      }, 30000);
    });

    const queueServiceE = await createQueueServiceImpl<JobData>(queueName, config)();
    expect(E.isRight(queueServiceE)).toBe(true);
    if (!E.isRight(queueServiceE)) return;

    // Clean up any existing jobs first
    await queueServiceE.right.drain()();

    const workerServiceE = await createWorkerService<JobData>(
      queueName,
      config,
      async (job: Job<JobData>) => {
        console.log('Processing job:', job.name, 'ID:', job.id);
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (job.id) processedJobs.add(job.id);
        console.log(
          'Job processed:',
          job.name,
          'ID:',
          job.id,
          'Total processed:',
          processedJobs.size,
        );
      },
      { concurrency: 1 },
    )();

    expect(E.isRight(workerServiceE)).toBe(true);
    if (!E.isRight(workerServiceE)) return;

    const jobs = Array.from({ length: jobCount }, (_, i) => ({
      data: createTestMetaJobData({
        name: defaultJobName,
        operation: 'SYNC',
        metaType: 'EVENTS' as MetaType,
      }),
      options: {
        jobId: `test-job-${i}`, // Ensure unique job IDs
      },
    }));

    const result = await queueServiceE.right.addBulk(jobs)();

    try {
      await jobsProcessed;
    } catch (error) {
      console.error('Job processing error:', error);
      throw error;
    } finally {
      await pipe(
        workerServiceE.right.close(),
        TE.chain(() => queueServiceE.right.drain()),
      )();
    }

    expect(result._tag).toBe('Right');
    expect(processedJobs.size).toBe(jobCount);
  }, 70000);

  it('should handle concurrent flow execution', async () => {
    const flowCount = 3;
    const childrenPerFlow = 2;
    const expectedJobCount = flowCount * (1 + childrenPerFlow); // Parent + children
    const processedJobs = new Set<string>();

    const jobsProcessed = new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        console.log('Current processed jobs:', processedJobs.size);
        if (processedJobs.size === expectedJobCount) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkInterval);
        console.error('Processed jobs:', processedJobs.size);
        console.error('Expected jobs:', expectedJobCount);
        reject(new Error('Concurrent flow execution timeout'));
      }, 30000);
    });

    const queueServiceE = await createQueueServiceImpl<JobData>(queueName, config)();
    expect(E.isRight(queueServiceE)).toBe(true);
    if (!E.isRight(queueServiceE)) return;

    const flowService = createFlowService<JobData>(queueServiceE.right.getQueue(), defaultJobName);

    const workerServiceE = await createWorkerService<JobData>(
      queueName,
      config,
      async (job: Job<JobData>) => {
        console.log('Processing job:', job.name, 'ID:', job.id);
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (job.id) processedJobs.add(job.id);
        console.log(
          'Job processed:',
          job.name,
          'ID:',
          job.id,
          'Total processed:',
          processedJobs.size,
        );
      },
      { concurrency: 1 },
    )();

    expect(E.isRight(workerServiceE)).toBe(true);
    if (!E.isRight(workerServiceE)) return;

    const flowPromises = Array.from({ length: flowCount }, async (_, i) => {
      const jobId = `flow-${i}`;
      const result = await flowService.addJob(
        createTestMetaJobData({
          name: defaultJobName,
          operation: 'SYNC',
          metaType: 'EVENTS' as MetaType,
        }),
        {
          jobId,
          children: Array.from({ length: childrenPerFlow }, (_, j) => ({
            name: defaultJobName,
            queueName,
            data: createTestMetaJobData({
              name: defaultJobName,
              operation: 'SYNC',
              metaType: 'EVENTS' as MetaType,
            }),
            opts: {
              jobId: `${jobId}-child-${j}`,
            },
          })),
        },
      )();

      return result;
    });

    const results = await Promise.all(flowPromises);
    const result = results.every((r: E.Either<QueueError, unknown>) => r._tag === 'Right');

    try {
      await jobsProcessed;
    } catch (error) {
      console.error('Job processing error:', error);
      throw error;
    }

    await pipe(
      workerServiceE.right.close(),
      TE.chain(() => queueServiceE.right.drain()),
    )();

    expect(result).toBe(true);
    expect(processedJobs.size).toBe(expectedJobCount);
  }, 70000);

  it('should handle scheduler performance under load', async () => {
    const schedulerCount = 3;
    const processedJobs = new Set<string>();

    const jobsProcessed = new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        console.log('Current processed jobs:', processedJobs.size);
        if (processedJobs.size >= schedulerCount) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);

      setTimeout(() => {
        clearInterval(checkInterval);
        console.error('Processed jobs:', processedJobs.size);
        console.error('Expected jobs:', schedulerCount);
        reject(new Error('Scheduler performance test timeout'));
      }, 30000);
    });

    const queueServiceE = await createQueueServiceImpl<JobData>(queueName, config)();
    expect(E.isRight(queueServiceE)).toBe(true);
    if (!E.isRight(queueServiceE)) return;

    const workerServiceE = await createWorkerService<JobData>(
      queueName,
      config,
      async (job: Job<JobData>) => {
        console.log('Processing job:', job.name, 'ID:', job.id);
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (job.id) processedJobs.add(job.id);
        console.log(
          'Job processed:',
          job.name,
          'ID:',
          job.id,
          'Total processed:',
          processedJobs.size,
        );
      },
      { concurrency: 1 },
    )();

    expect(E.isRight(workerServiceE)).toBe(true);
    if (!E.isRight(workerServiceE)) return;

    const schedulerPromises = Array.from({ length: schedulerCount }, async (_, i) => {
      console.log(`Adding scheduler ${i}...`);
      const result = await queueServiceE.right.upsertJobScheduler(`scheduler-${i}`, {
        every: 1000, // Run every second
      })();

      if (result._tag === 'Right') {
        console.log(`Scheduler ${i} added successfully`);
      }

      return result;
    });

    const results = await Promise.all(schedulerPromises);
    const result = results.every((r: E.Either<QueueError, unknown>) => r._tag === 'Right');

    try {
      await jobsProcessed;
    } catch (error) {
      console.error('Job processing error:', error);
      throw error;
    }

    await pipe(
      workerServiceE.right.close(),
      TE.chain(() => queueServiceE.right.drain()),
    )();

    expect(result).toBe(true);
    expect(processedJobs.size).toBeGreaterThanOrEqual(schedulerCount);
  }, 70000);
});
