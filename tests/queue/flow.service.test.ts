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
  const queueName = 'test-flow-queue';
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
    flowService = createFlowService<TestJobData>(queueService.getQueue(), 'flow' as JobName);
  });

  afterEach(async () => {
    await queueService.getQueue().obliterate();
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
            opts: { jobId: 'child-job-1' },
          },
        ],
      };

      // Add parent job with child
      const parentResult = await flowService.addJob(parentFlow.data, {
        jobId: parentJobId,
        children: parentFlow.children,
      })();
      expect(E.isRight(parentResult)).toBe(true);

      if (E.isRight(parentResult)) {
        // Wait for jobs to be processed
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Verify parent-child relationship
        const dependencies = await flowService.getFlowDependencies(parentJobId)();
        expect(E.isRight(dependencies)).toBe(true);

        if (E.isRight(dependencies)) {
          const deps = dependencies.right;
          expect(deps).toHaveLength(1);
          expect(deps[0].name).toBe('flow');
          expect(deps[0].data).toEqual({
            type: 'META',
            timestamp: expect.any(Date),
            name: 'flow',
            data: { value: 'child' },
          });
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
    });
  });
});
