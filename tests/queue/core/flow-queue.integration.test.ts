import { Job, Queue } from 'bullmq';
import { pipe } from 'fp-ts/function';
import { createFlowService } from '../../../src/infrastructure/queue/core/flow.service';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { QueueService, WorkerService } from '../../../src/infrastructure/queue/types';
import { JobName, MetaJobData, MetaType } from '../../../src/types/job.type';

describe('Flow Queue Integration Tests', () => {
  const queueName = 'test-flow-queue';
  const defaultJobName: JobName = 'meta';
  let queueService: QueueService<MetaJobData>;
  let workerService: WorkerService<MetaJobData>;
  let flowService: ReturnType<typeof createFlowService>;
  let queue: Queue<MetaJobData>;

  const waitForJobCompletion = async (jobId: string, timeoutMs = 10000): Promise<void> => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const job = await queue.getJob(jobId);
      if (job && (await job.isCompleted())) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Job ${jobId} did not complete within ${timeoutMs}ms`);
  };

  const cleanupQueue = async (queue: Queue<MetaJobData>): Promise<void> => {
    try {
      await queue.pause();
      await queue.clean(0, 0, 'completed');
      await queue.clean(0, 0, 'failed');
      await queue.clean(0, 0, 'delayed');
      await queue.clean(0, 0, 'wait');
      await queue.clean(0, 0, 'active');
      await queue.obliterate();
      await queue.resume();
    } catch (error) {
      console.warn('Queue cleanup warning:', error);
    }
  };

  beforeAll(async () => {
    const queueServiceResult = await createQueueServiceImpl<MetaJobData>(queueName)();
    if (queueServiceResult._tag === 'Left') {
      throw new Error('Failed to create queue service');
    }
    queueService = queueServiceResult.right;
    queue = queueService.getQueue();
    await cleanupQueue(queue);

    // Create worker service
    const workerServiceResult = await createWorkerService<MetaJobData>(
      queueName,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate work
      },
      { concurrency: 1 },
    )();
    if (workerServiceResult._tag === 'Left') {
      throw new Error('Failed to create worker service');
    }
    workerService = workerServiceResult.right;
    await workerService.start();

    // Create flow service
    flowService = createFlowService<MetaJobData>(queue, defaultJobName);
    await flowService.init();
  });

  afterAll(async () => {
    await workerService.close();
    await flowService.close();
    await cleanupQueue(queue);
  });

  describe('Flow Queue Integration', () => {
    test('should process flow jobs in correct order', async () => {
      const jobData: MetaJobData = {
        type: 'META',
        name: defaultJobName,
        data: {
          operation: 'SYNC',
          metaType: 'COURSE' as MetaType,
        },
        timestamp: new Date(),
      };

      const result = await pipe(
        flowService.addJob(jobData, {
          jobId: 'parent-job',
          children: [
            {
              name: defaultJobName,
              queueName,
              data: {
                ...jobData,
                name: defaultJobName,
              },
              opts: { jobId: 'child-1' },
            },
            {
              name: defaultJobName,
              queueName,
              data: {
                ...jobData,
                name: defaultJobName,
              },
              opts: { jobId: 'child-2' },
            },
          ],
        }),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right' && result.right.opts?.jobId) {
        await waitForJobCompletion(result.right.opts.jobId);
        const dependencies = await flowService.getFlowDependencies(result.right.opts.jobId)();
        expect(dependencies._tag).toBe('Right');
        if (dependencies._tag === 'Right') {
          expect(dependencies.right.length).toBe(3);
        }
      }
    }, 40000);

    test('should handle flow job failure', async () => {
      // Create worker service with failure simulation
      const failingWorkerServiceResult = await createWorkerService<MetaJobData>(
        queueName,
        async (job: Job<MetaJobData>) => {
          if (job.attemptsMade === 0) {
            throw new Error('Simulated failure');
          }
        },
        { concurrency: 1 },
      )();
      if (failingWorkerServiceResult._tag === 'Left') {
        throw new Error('Failed to create failing worker service');
      }

      // Close existing worker service
      await workerService.close();
      workerService = failingWorkerServiceResult.right;
      await workerService.start();

      const jobData: MetaJobData = {
        type: 'META',
        name: defaultJobName,
        data: {
          operation: 'SYNC',
          metaType: 'COURSE' as MetaType,
        },
        timestamp: new Date(),
      };

      const result = await pipe(
        flowService.addJob(jobData, {
          jobId: 'failing-job',
        }),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right' && result.right.opts?.jobId) {
        await waitForJobCompletion(result.right.opts.jobId);
        const job = await queue.getJob(result.right.opts.jobId);
        expect(job?.attemptsMade).toBeGreaterThan(0);
      }
    }, 20000);

    test('should get flow dependencies', async () => {
      const jobData: MetaJobData = {
        type: 'META',
        name: defaultJobName,
        data: {
          operation: 'SYNC',
          metaType: 'COURSE' as MetaType,
        },
        timestamp: new Date(),
      };

      const result = await pipe(
        flowService.addJob(jobData, {
          jobId: 'parent-job-2',
          children: [
            {
              name: defaultJobName,
              queueName,
              data: {
                ...jobData,
                name: defaultJobName,
              },
              opts: { jobId: 'child-1-2' },
            },
          ],
        }),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right' && result.right.opts?.jobId) {
        await waitForJobCompletion(result.right.opts.jobId);
        const dependencies = await flowService.getFlowDependencies(result.right.opts.jobId)();
        expect(dependencies._tag).toBe('Right');
        if (dependencies._tag === 'Right') {
          expect(dependencies.right.length).toBe(2);
        }
      }
    }, 20000);
  });
});
