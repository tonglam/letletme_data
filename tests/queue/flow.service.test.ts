import { Worker } from 'bullmq';
import * as E from 'fp-ts/Either';
import { createFlowService } from '../../src/infrastructure/queue/core/flow.service';
import { QueueServiceImpl } from '../../src/infrastructure/queue/core/queue.service';
import { FlowJob, FlowService } from '../../src/infrastructure/queue/types';
import { BaseJobData, JobName } from '../../src/types/job.type';

// Define test job data type
interface TestJobData extends BaseJobData {
  readonly type: 'META';
  readonly name: JobName;
  readonly data: { value: string };
}

describe('Flow Service', () => {
  const queueName = 'test-queue';
  let queueService: QueueServiceImpl<TestJobData>;
  let flowService: FlowService<TestJobData>;
  let worker: Worker<TestJobData>;

  beforeAll(async () => {
    queueService = new QueueServiceImpl<TestJobData>({
      connection: {
        host: 'localhost',
        port: 6379,
      },
    });

    // Create a worker to process jobs
    worker = new Worker<TestJobData>(
      queueName,
      async (job) => {
        console.log('Processing job:', job.id, job.data);
        return job.data;
      },
      {
        connection: {
          host: 'localhost',
          port: 6379,
        },
      },
    );
  });

  beforeEach(async () => {
    // Create flow service with the same queue name
    flowService = createFlowService<TestJobData>(queueService.getQueue(), 'flow' as JobName);
    // Clear the queue before each test
    await queueService.getQueue().obliterate({ force: true });
  });

  afterEach(async () => {
    await queueService.getQueue().obliterate({ force: true });
    await flowService.close();
  });

  afterAll(async () => {
    await worker.close();
    await queueService.close();
  });

  describe('Parent-Child Relationship', () => {
    it('should handle parent-child relationship correctly', async () => {
      // Create parent job with specific jobId
      const parentJobId = 'parent-job-1';
      const childJobId = 'child-job-1';
      const parentFlow: FlowJob<TestJobData> = {
        name: 'flow' as JobName,
        queueName,
        data: {
          type: 'META',
          timestamp: new Date(),
          name: 'flow' as JobName,
          data: { value: 'parent' },
        },
        opts: { jobId: parentJobId },
        children: [
          {
            name: 'flow' as JobName,
            queueName,
            data: {
              type: 'META',
              timestamp: new Date(),
              name: 'flow' as JobName,
              data: { value: 'child' },
            },
            opts: { jobId: childJobId },
          },
        ],
      };

      try {
        // Add parent job with child
        const parentResult = await flowService.addJob(parentFlow.data, {
          jobId: parentJobId,
          children: parentFlow.children,
        })();
        expect(E.isRight(parentResult)).toBe(true);

        if (E.isRight(parentResult)) {
          // Wait for jobs to be processed
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Verify parent-child relationship
          const dependencies = await flowService.getFlowDependencies(parentJobId)();
          expect(E.isRight(dependencies)).toBe(true);

          if (E.isRight(dependencies)) {
            const deps = dependencies.right;
            expect(deps).toHaveLength(2); // Should have both parent and child

            // Verify parent job
            const parentDep = deps.find((d) => d.opts?.jobId === parentJobId);
            expect(parentDep).toBeDefined();
            if (parentDep) {
              expect(parentDep.name).toBe('flow');
              expect(parentDep.data).toEqual({
                type: 'META',
                timestamp: expect.any(Date),
                name: 'flow',
                data: { value: 'parent' },
              });
            }

            // Verify child job
            const childDep = deps.find((d) => d.opts?.jobId === childJobId);
            expect(childDep).toBeDefined();
            if (childDep && childDep.opts) {
              expect(childDep.name).toBe('flow');
              expect(childDep.data).toEqual({
                type: 'META',
                timestamp: expect.any(Date),
                name: 'flow',
                data: { value: 'child' },
              });
              // BullMQ adds 'bull:' prefix to queue names
              expect(childDep.opts.parent?.queue).toBe('test-queue');
            }
          }

          // Verify child values can be accessed from parent
          const childrenValues = await flowService.getChildrenValues(parentJobId)();
          expect(E.isRight(childrenValues)).toBe(true);

          if (E.isRight(childrenValues)) {
            const values = childrenValues.right;
            expect(Object.keys(values)).toHaveLength(1); // Should have one child value
            expect(Object.values(values)[0]).toEqual({
              type: 'META',
              timestamp: expect.any(Date),
              name: 'flow',
              data: { value: 'child' },
            });
          }
        }
      } catch (error) {
        console.error('Test error:', error);
        throw error;
      }
    }, 30000); // Increase timeout to 30 seconds
  });
});
