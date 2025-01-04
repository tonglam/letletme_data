import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../src/config/queue/queue.config';
import { createQueueService } from '../../src/infrastructure/queue/core/queue.service';
import { QueueError, QueueErrorCode } from '../../src/types/errors.type';
import { JobData, JobName } from '../../src/types/job.type';

describe('Queue Service Tests', () => {
  const queueName = 'test-queue';
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

  describe('Core Operations', () => {
    test('should create queue with configuration', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.map((service) => service.getQueue()),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const queue = result.right;
        expect(queue.name).toBe(queueName);
      }
    });

    test('should add job successfully', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) =>
          service.addJob({
            type: 'META',
            name: 'meta' as JobName,
            data: { value: 1 },
            timestamp: new Date(),
          }),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should add bulk jobs successfully', async () => {
      const jobs = [
        {
          data: {
            type: 'META' as const,
            name: 'meta' as JobName,
            data: { value: 1 },
            timestamp: new Date(),
          },
        },
        {
          data: {
            type: 'LIVE' as const,
            name: 'live' as JobName,
            data: { value: 2 },
            timestamp: new Date(),
          },
        },
      ];

      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) => service.addBulk(jobs)),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should remove job successfully', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) =>
          pipe(
            service.addJob({
              type: 'META',
              name: 'meta' as JobName,
              data: { value: 1 },
              timestamp: new Date(),
            }),
            TE.chain(() => service.removeJob('meta-job')),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should drain queue successfully', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) => service.drain()),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should clean queue successfully', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) => service.clean(1000, 100, 'completed')),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should obliterate queue successfully', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) => service.obliterate()),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should pause and resume queue successfully', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) =>
          pipe(
            service.pause(),
            TE.chain(() => service.resume()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid configuration', async () => {
      const invalidConfig: QueueConfig = {
        producerConnection: {
          host: 'invalid-host',
          port: -1,
        },
        consumerConnection: {
          host: 'invalid-host',
          port: -1,
        },
      };

      const result = await pipe(
        createQueueService<JobData>(queueName, invalidConfig),
        TE.chain((service) =>
          service.addJob({
            type: 'META',
            name: 'meta' as JobName,
            data: { value: 1 },
            timestamp: new Date(),
          }),
        ),
      )();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        const error = result.left as QueueError;
        expect(error.code).toBe(QueueErrorCode.ADD_JOB);
      }
    });

    test('should handle job addition with invalid data', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.chain((service) =>
          service.addJob({
            type: 'INVALID_TYPE' as JobData['type'],
            name: 'meta' as JobName,
            data: { value: 'not a number' },
            timestamp: 'not a date' as unknown as Date,
          }),
        ),
      )();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        const error = result.left as QueueError;
        expect(error.code).toBe(QueueErrorCode.INVALID_JOB_DATA);
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
