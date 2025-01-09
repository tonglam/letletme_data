import { config } from 'dotenv';
config();

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { QueueService } from '../../../src/infrastructure/queue/types';
import { QueueError, QueueErrorCode } from '../../../src/types/error.type';
import { JobData, JobName, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData } from '../../utils/queue.test.utils';

describe('Queue Service Tests', () => {
  // Validate Redis configuration
  beforeAll(() => {
    if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD) {
      throw new Error('Redis configuration is missing. Please check your .env file.');
    }
  });

  const queueName = 'test-queue';
  const defaultJobName: JobName = 'meta';

  describe('Core Operations', () => {
    test('should create queue with configuration', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.map((service: QueueService<JobData>) => service.getQueue()),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const queue = result.right;
        expect(queue.name).toBe(queueName);
      }
    });

    test('should add job successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) =>
          service.addJob(createTestMetaJobData({ name: defaultJobName })),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should add job with options successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) =>
          service.addJob(createTestMetaJobData({ name: defaultJobName }), {
            priority: 1,
            delay: 1000,
            attempts: 3,
          }),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should add bulk jobs successfully', async () => {
      const jobs = Array.from({ length: 3 }, () => ({
        data: createTestMetaJobData({ name: defaultJobName }),
      }));

      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) => service.addBulk(jobs)),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should drain queue successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) => service.drain()),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should clean queue successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) => service.clean(1000, 100, 'completed')),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should pause and resume queue successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) =>
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
    test('should handle null job data', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) =>
          service.addJob(null as unknown as MetaJobData),
        ),
      )();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        const error = result.left as QueueError;
        expect(error.code).toBe(QueueErrorCode.INVALID_JOB_DATA);
        expect(error.error.message).toBe('Job data must be a non-null object');
      }
    });

    test('should handle missing name field', async () => {
      const invalidData = {
        type: 'META',
        timestamp: new Date(),
        data: {},
      } as unknown as MetaJobData;

      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) => service.addJob(invalidData)),
      )();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        const error = result.left as QueueError;
        expect(error.code).toBe(QueueErrorCode.INVALID_JOB_DATA);
        expect(error.error.message).toBe('Job data must contain a name');
      }
    });

    test('should handle missing type field', async () => {
      const invalidData = {
        name: 'meta',
        timestamp: new Date(),
        data: {},
      } as unknown as MetaJobData;

      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) => service.addJob(invalidData)),
      )();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        const error = result.left as QueueError;
        expect(error.code).toBe(QueueErrorCode.INVALID_JOB_DATA);
        expect(error.error.message).toBe('Job data must contain a type');
      }
    });

    test('should handle missing timestamp field', async () => {
      const invalidData = {
        type: 'META',
        name: 'meta',
        data: {},
      } as unknown as MetaJobData;

      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) => service.addJob(invalidData)),
      )();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        const error = result.left as QueueError;
        expect(error.code).toBe(QueueErrorCode.INVALID_JOB_DATA);
        expect(error.error.message).toBe('Job data must contain a timestamp');
      }
    });

    test('should handle missing data field', async () => {
      const invalidData = {
        type: 'META',
        name: 'meta',
        timestamp: new Date(),
      } as unknown as MetaJobData;

      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName),
        TE.chain((service: QueueService<JobData>) => service.addJob(invalidData)),
      )();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        const error = result.left as QueueError;
        expect(error.code).toBe(QueueErrorCode.INVALID_JOB_DATA);
        expect(error.error.message).toBe('Job data must contain a data field');
      }
    });
  });

  // Cleanup after each test
  afterEach(async () => {
    const cleanup = await pipe(
      createQueueServiceImpl<JobData>(queueName),
      TE.chain((service: QueueService<JobData>) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });
});
