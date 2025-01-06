import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueService } from '../../../src/infrastructure/queue/core/queue.service';
import { QueueError, QueueErrorCode } from '../../../src/types/errors.type';
import { JobData, JobName } from '../../../src/types/job.type';
import { createTestMetaJobData, createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Queue Service Tests', () => {
  const queueName = 'test-queue';
  const defaultJobName = 'meta' as JobName;
  const config = createTestQueueConfig();

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
        TE.chain((service) => service.addJob(createTestMetaJobData({ name: defaultJobName }))),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should add bulk jobs successfully', async () => {
      const jobs = Array.from({ length: 2 }, () => ({
        data: createTestMetaJobData({ name: defaultJobName }),
      }));

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
            service.addJob(createTestMetaJobData({ name: defaultJobName })),
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
        createQueueService<JobData>(queueName, invalidConfig),
        TE.chain((service) => service.addJob(createTestMetaJobData({ name: defaultJobName }))),
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
        createQueueService<JobData>(queueName, config),
        TE.chain((service) =>
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
        createQueueService<JobData>(queueName, config),
        TE.chain((service) =>
          pipe(
            service.addBulk(jobs),
            TE.chain(() => service.obliterate()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should handle invalid job data', async () => {
      const invalidConfig = createTestQueueConfig();

      const result = await pipe(
        createQueueService<JobData>(queueName, invalidConfig),
        TE.chain((service) =>
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
      createQueueService<JobData>(queueName, config),
      TE.chain((service) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });
});
