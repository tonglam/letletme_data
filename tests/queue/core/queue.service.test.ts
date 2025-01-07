import { config } from 'dotenv';
config();

import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { QueueService } from '../../../src/infrastructure/queue/types';
import { QueueError, QueueErrorCode } from '../../../src/types/error.type';
import { JobData, JobName } from '../../../src/types/job.type';
import { createTestMetaJobData, createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Queue Service Tests', () => {
  // Validate Redis configuration
  beforeAll(() => {
    if (!process.env.REDIS_HOST || !process.env.REDIS_PASSWORD) {
      throw new Error('Redis configuration is missing. Please check your .env file.');
    }
  });

  const queueName = 'test-queue';
  const defaultJobName: JobName = 'meta';
  const queueConfig = createTestQueueConfig({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
    password: process.env.REDIS_PASSWORD,
  });

  describe('Core Operations', () => {
    test('should create queue with configuration', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
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
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) =>
          service.addJob(createTestMetaJobData({ name: defaultJobName })),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should add bulk jobs successfully', async () => {
      const jobs = Array.from({ length: 2 }, () => ({
        data: createTestMetaJobData({ name: defaultJobName }),
      }));

      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) => service.addBulk(jobs)),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should remove job successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) =>
          pipe(
            service.addJob(createTestMetaJobData({ name: defaultJobName })),
            TE.chain(() => service.removeJob('meta-job')),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should drain queue successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) => service.drain()),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should clean queue successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) => service.clean(1000, 100, 'completed')),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should obliterate queue successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) => service.obliterate()),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should pause and resume queue successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
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
    test('should handle invalid configuration', async () => {
      const invalidConfig = {
        connection: {
          host: 'invalid-host',
          port: -1,
          password: 'test',
        },
        producerConnection: {
          host: 'invalid-host',
          port: -1,
          password: 'test',
        },
        consumerConnection: {
          host: 'invalid-host',
          port: -1,
          password: 'test',
        },
      };

      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, invalidConfig),
        TE.chain((service: QueueService<JobData>) =>
          service.addJob(createTestMetaJobData({ name: defaultJobName })),
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
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) =>
          service.addJob({
            type: 'INVALID_TYPE' as JobData['type'],
            name: defaultJobName,
            data: {
              operation: 'SYNC',
              metaType: 'EVENTS',
            },
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

  describe('Job Operations', () => {
    test('should add job to queue', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) =>
          pipe(
            service.addJob(createTestMetaJobData({ name: defaultJobName })),
            TE.chain(() => service.obliterate()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should add bulk jobs to queue', async () => {
      const jobs = Array.from({ length: 3 }, () => ({
        data: createTestMetaJobData({ name: defaultJobName }),
      }));

      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) =>
          pipe(
            service.addBulk(jobs),
            TE.chain(() => service.obliterate()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should handle invalid job data', async () => {
      const result = await pipe(
        createQueueServiceImpl<JobData>(queueName, queueConfig),
        TE.chain((service: QueueService<JobData>) =>
          pipe(
            service.addJob(createTestMetaJobData({ name: defaultJobName })),
            TE.chain(() => service.obliterate()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });
  });

  // Cleanup after each test
  afterEach(async () => {
    const cleanup = await pipe(
      createQueueServiceImpl<JobData>(queueName, queueConfig),
      TE.chain((service: QueueService<JobData>) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });
});
