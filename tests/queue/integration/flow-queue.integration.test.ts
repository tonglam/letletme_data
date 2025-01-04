import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../src/config/queue/queue.config';
import { createFlowService } from '../../../src/infrastructure/queue/core/flow.service';
import { createQueueService } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { FlowJob } from '../../../src/infrastructure/queue/types';
import { QueueError } from '../../../src/types/errors.type';
import { JobData, JobName } from '../../../src/types/job.type';

describe('Flow-Queue Integration Tests', () => {
  const queueName = 'test-flow-queue';
  const defaultJobName = 'meta' as JobName;
  const config: QueueConfig = {
    producerConnection: {
      host: 'localhost',
      port: 6379,
    },
    consumerConnection: {
      host: 'localhost',
      port: 6379,
    },
  };

  describe('Flow Job Processing', () => {
    test('should process flow jobs in correct order', async () => {
      const processedJobs: string[] = [];

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('queue', ({ queueService }) => TE.right(queueService.getQueue())),
        TE.bind('flowService', ({ queue }) =>
          TE.tryCatch(
            async () => createFlowService<JobData>(queue, defaultJobName),
            (error) => error as QueueError,
          ),
        ),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(queueName, config, async (job: Job<JobData>) => {
            processedJobs.push(job.name);
          }),
        ),
        TE.chain(({ flowService, workerService }) =>
          pipe(
            flowService.addJob(
              {
                type: 'META',
                name: 'parent' as JobName,
                data: { value: 1 },
                timestamp: new Date(),
              },
              {
                jobId: 'parent-job',
                children: [
                  {
                    name: 'child1',
                    queueName,
                    data: {
                      type: 'META',
                      name: 'child1' as JobName,
                      data: { value: 2 },
                      timestamp: new Date(),
                    },
                  },
                  {
                    name: 'child2',
                    queueName,
                    data: {
                      type: 'META',
                      name: 'child2' as JobName,
                      data: { value: 3 },
                      timestamp: new Date(),
                    },
                  },
                ],
              },
            ),
            // Wait for job processing
            TE.chain(() =>
              TE.tryCatch(
                () => new Promise((resolve) => setTimeout(resolve, 2000)),
                (error) => error as QueueError,
              ),
            ),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs).toContain('child1');
      expect(processedJobs).toContain('child2');
      expect(processedJobs).toContain('parent');
      // Parent should be processed after children
      expect(processedJobs.indexOf('parent')).toBeGreaterThan(processedJobs.indexOf('child1'));
      expect(processedJobs.indexOf('parent')).toBeGreaterThan(processedJobs.indexOf('child2'));
    });

    test('should handle flow job failure', async () => {
      const processedJobs: string[] = [];
      const failedJobs: string[] = [];

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('queue', ({ queueService }) => TE.right(queueService.getQueue())),
        TE.bind('flowService', ({ queue }) =>
          TE.tryCatch(
            async () => createFlowService<JobData>(queue, defaultJobName),
            (error) => error as QueueError,
          ),
        ),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(queueName, config, async (job: Job<JobData>) => {
            if (job.name === 'child1') {
              failedJobs.push(job.name);
              throw new Error('Simulated child failure');
            }
            processedJobs.push(job.name);
          }),
        ),
        TE.chain(({ flowService, workerService }) =>
          pipe(
            flowService.addJob(
              {
                type: 'META',
                name: 'parent' as JobName,
                data: { value: 1 },
                timestamp: new Date(),
              },
              {
                jobId: 'parent-job',
                children: [
                  {
                    name: 'child1',
                    queueName,
                    data: {
                      type: 'META',
                      name: 'child1' as JobName,
                      data: { value: 2 },
                      timestamp: new Date(),
                    },
                  },
                  {
                    name: 'child2',
                    queueName,
                    data: {
                      type: 'META',
                      name: 'child2' as JobName,
                      data: { value: 3 },
                      timestamp: new Date(),
                    },
                  },
                ],
              },
            ),
            // Wait for job processing
            TE.chain(() =>
              TE.tryCatch(
                () => new Promise((resolve) => setTimeout(resolve, 2000)),
                (error) => error as QueueError,
              ),
            ),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(failedJobs).toContain('child1');
      expect(processedJobs).toContain('child2');
      // Parent should not be processed due to child failure
      expect(processedJobs).not.toContain('parent');
    });

    test('should get flow dependencies', async () => {
      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('queue', ({ queueService }) => TE.right(queueService.getQueue())),
        TE.bind('flowService', ({ queue }) =>
          TE.tryCatch(
            async () => createFlowService<JobData>(queue, defaultJobName),
            (error) => error as QueueError,
          ),
        ),
        TE.chain(({ flowService }) =>
          pipe(
            flowService.addJob(
              {
                type: 'META',
                name: 'parent' as JobName,
                data: { value: 1 },
                timestamp: new Date(),
              },
              {
                jobId: 'parent-job',
                children: [
                  {
                    name: 'child1',
                    queueName,
                    data: {
                      type: 'META',
                      name: 'child1' as JobName,
                      data: { value: 2 },
                      timestamp: new Date(),
                    },
                  },
                ],
              },
            ),
            TE.chain(() => flowService.getFlowDependencies('parent-job')),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const dependencies = result.right as FlowJob<JobData>[];
        expect(dependencies.length).toBe(2); // Parent and one child
        expect(dependencies.find((d: FlowJob<JobData>) => d.name === 'parent')).toBeDefined();
        expect(dependencies.find((d: FlowJob<JobData>) => d.name === 'child1')).toBeDefined();
      }
    });
  });

  // Cleanup after each test
  afterEach(async () => {
    const cleanup = await pipe(
      createQueueService<JobData>(queueName, config),
      TE.chain((service) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });
});
