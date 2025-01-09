import { Worker } from 'bullmq';
import * as E from 'fp-ts/Either';
import { createFlowService } from '../../../src/infrastructure/queue/core/flow.service';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { FlowJob, FlowService, QueueService } from '../../../src/infrastructure/queue/types';
import { JobName, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData } from '../../utils/queue.test.utils';

describe('Flow Service', () => {
  const queueName = 'test-queue';
  let queueService: QueueService<MetaJobData>;
  let flowService: FlowService<MetaJobData>;
  let worker: Worker<MetaJobData>;

  beforeAll(async () => {
    const queueServiceResult = await createQueueServiceImpl<MetaJobData>(queueName)();
    if (queueServiceResult._tag === 'Left') {
      throw queueServiceResult.left;
    }
    queueService = queueServiceResult.right;

    // Create a worker to process jobs
    worker = new Worker<MetaJobData>(queueName, async (job) => {
      console.log('Processing job:', job.id, job.data);
      return job.data;
    });
  });

  beforeEach(async () => {
    // Create flow service with the same queue name
    flowService = createFlowService<MetaJobData>(queueService.getQueue(), 'flow' as JobName);
    // Clear the queue before each test
    await queueService.getQueue().obliterate({ force: true });
  });

  afterEach(async () => {
    await queueService.getQueue().obliterate({ force: true });
    await flowService.close();
  });

  afterAll(async () => {
    await worker.close();
    await queueService.getQueue().disconnect();
  });

  describe('Parent-Child Relationship', () => {
    it('should handle parent-child relationship correctly', async () => {
      // Create parent job with specific jobId
      const parentJobId = 'parent-job-1';
      const childJobId = 'child-job-1';
      const parentFlow: FlowJob<MetaJobData> = {
        name: 'flow' as JobName,
        queueName,
        data: createTestMetaJobData({ name: 'flow' as JobName }),
        opts: { jobId: parentJobId },
        children: [
          {
            name: 'flow' as JobName,
            queueName,
            data: createTestMetaJobData({ name: 'flow' as JobName }),
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
                data: {
                  operation: 'SYNC',
                  metaType: 'EVENTS',
                },
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
                data: {
                  operation: 'SYNC',
                  metaType: 'EVENTS',
                },
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
              data: {
                operation: 'SYNC',
                metaType: 'EVENTS',
              },
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
