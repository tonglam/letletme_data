import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../src/config/queue/queue.config';
import { createQueueService } from '../../src/infrastructure/queue/core/queue.service';
import { createSchedulerService } from '../../src/infrastructure/queue/core/scheduler.service';
import { QueueError, QueueErrorCode } from '../../src/types/errors.type';
import { JobData, JobName } from '../../src/types/job.type';

describe('Scheduler Service Tests', () => {
  const queueName = 'test-scheduler-queue';
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
    test('should create scheduler service', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.map((service) => createSchedulerService(queueName, service.getQueue())),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should create interval-based job scheduler', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.map((service) => createSchedulerService(queueName, service.getQueue())),
        TE.chain((scheduler) =>
          scheduler.upsertJobScheduler(
            'interval-job',
            { every: 1000 }, // Run every second
            {
              name: 'interval-test',
              data: {
                type: 'META' as const,
                name: 'meta' as JobName,
                data: { value: 1 },
                timestamp: new Date(),
              },
            },
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should create cron-based job scheduler', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.map((service) => createSchedulerService(queueName, service.getQueue())),
        TE.chain((scheduler) =>
          scheduler.upsertJobScheduler(
            'cron-job',
            { pattern: '*/5 * * * *' }, // Run every 5 minutes
            {
              name: 'cron-test',
              data: {
                type: 'META' as const,
                name: 'meta' as JobName,
                data: { value: 1 },
                timestamp: new Date(),
              },
            },
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should list job schedulers with pagination', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.map((service) => createSchedulerService(queueName, service.getQueue())),
        TE.chain((scheduler) =>
          pipe(
            // Create two schedulers
            scheduler.upsertJobScheduler(
              'job-1',
              { every: 1000 },
              {
                name: 'test-1',
                data: {
                  type: 'META' as const,
                  name: 'meta' as JobName,
                  data: { value: 1 },
                  timestamp: new Date(),
                },
              },
            ),
            TE.chain(() =>
              scheduler.upsertJobScheduler(
                'job-2',
                { every: 2000 },
                {
                  name: 'test-2',
                  data: {
                    type: 'META' as const,
                    name: 'meta' as JobName,
                    data: { value: 2 },
                    timestamp: new Date(),
                  },
                },
              ),
            ),
            // List schedulers with pagination
            TE.chain(() => scheduler.getJobSchedulers({ page: 1, pageSize: 1 })),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const schedulers = result.right;
        expect(schedulers.length).toBeLessThanOrEqual(2);
        expect(schedulers[0]).toHaveProperty('jobId');
        expect(schedulers[0]).toHaveProperty('nextRun');
        expect(schedulers[0]).toHaveProperty('lastRun');
      }
    });

    test('should sort job schedulers by next run time', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.map((service) => createSchedulerService(queueName, service.getQueue())),
        TE.chain((scheduler) =>
          pipe(
            // Create two schedulers with different intervals
            scheduler.upsertJobScheduler(
              'fast-job',
              { every: 1000 },
              {
                name: 'fast-test',
                data: {
                  type: 'META' as const,
                  name: 'meta' as JobName,
                  data: { value: 1 },
                  timestamp: new Date(),
                },
              },
            ),
            TE.chain(() =>
              scheduler.upsertJobScheduler(
                'slow-job',
                { every: 5000 },
                {
                  name: 'slow-test',
                  data: {
                    type: 'META' as const,
                    name: 'meta' as JobName,
                    data: { value: 2 },
                    timestamp: new Date(),
                  },
                },
              ),
            ),
            // Get schedulers sorted by next run time
            TE.chain(() => scheduler.getJobSchedulers()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const schedulers = result.right;
        expect(schedulers.length).toBeGreaterThan(0);
        if (schedulers.length > 1) {
          const firstNextRun = schedulers[0].nextRun?.getTime() ?? 0;
          const secondNextRun = schedulers[1].nextRun?.getTime() ?? 0;
          expect(firstNextRun).toBeLessThanOrEqual(secondNextRun);
        }
      }
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid scheduler creation', async () => {
      const result = await pipe(
        createQueueService<JobData>(queueName, config),
        TE.map((service) => createSchedulerService(queueName, service.getQueue())),
        TE.chain((scheduler) =>
          scheduler.upsertJobScheduler(
            'invalid-job',
            { pattern: 'invalid-cron' }, // Invalid cron pattern
            {
              name: 'invalid-test',
              data: {
                type: 'META' as const,
                name: 'meta' as JobName,
                data: { value: 1 },
                timestamp: new Date(),
              },
            },
          ),
        ),
      )();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        const error = result.left as QueueError;
        expect(error.code).toBe(QueueErrorCode.CREATE_JOB_SCHEDULER);
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
