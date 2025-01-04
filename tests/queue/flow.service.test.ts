import * as E from 'fp-ts/Either';
import { createFlowService } from '../../src/infrastructure/queue/core/flow.service';
import { QueueServiceImpl } from '../../src/infrastructure/queue/core/queue.service';
import { FlowJob } from '../../src/infrastructure/queue/types';

describe('Flow Service', () => {
  const queueName = 'test-flow-queue';
  let queueService: QueueServiceImpl;
  let flowService: ReturnType<typeof createFlowService>;

  beforeAll(async () => {
    queueService = new QueueServiceImpl({
      connection: {
        host: 'localhost',
        port: 6379,
      },
    });
  });

  beforeEach(async () => {
    flowService = createFlowService<unknown>(queueService.getQueue(), queueName);
  });

  afterEach(async () => {
    await queueService.getQueue().obliterate();
  });

  afterAll(async () => {
    await queueService.close();
  });

  describe('Parent-Child Relationship', () => {
    it('should handle parent-child relationship correctly', async () => {
      // Create parent job
      const parentFlow: FlowJob<unknown> = {
        name: 'parent-flow',
        queueName,
        data: { value: 'parent' },
        opts: {},
        children: [],
      };

      // Add parent job
      const parentResult = await flowService.addJob(parentFlow.data, parentFlow.opts)();
      expect(E.isRight(parentResult)).toBe(true);

      if (E.isRight(parentResult)) {
        const parentJob: FlowJob<unknown> = parentResult.right;

        // Create and add child job with parent reference
        const childFlow: FlowJob<unknown> = {
          name: 'child-flow',
          queueName,
          data: { value: 'child' },
          opts: {},
          children: [],
        };

        const childResult = await flowService.addJob(childFlow.data, {
          ...childFlow.opts,
          parent: { id: parentJob.name, queue: parentJob.queueName },
        })();
        expect(E.isRight(childResult)).toBe(true);

        // Verify parent-child relationship
        const dependencies = await flowService.getFlowDependencies(parentJob.name)();
        expect(E.isRight(dependencies)).toBe(true);

        if (E.isRight(dependencies)) {
          const deps = dependencies.right as FlowJob<unknown>[];
          expect(deps).toHaveLength(1);
          expect(deps[0].name).toBe(childFlow.name);
          expect(deps[0].data).toEqual(childFlow.data);
        }

        // Verify child values can be accessed from parent
        const childrenValues = await flowService.getChildrenValues(parentJob.name)();
        expect(E.isRight(childrenValues)).toBe(true);

        if (E.isRight(childrenValues)) {
          const values = childrenValues.right as Record<string, unknown>;
          expect(Object.keys(values)).toHaveLength(0); // Initially empty until child job completes
        }
      }
    });
  });
});
