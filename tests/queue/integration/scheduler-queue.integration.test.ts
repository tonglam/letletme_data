import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../../src/config/queue/queue.config';
import { createQueueService } from '../../../src/infrastructure/queue/core/queue.service';
import { createWorkerService } from '../../../src/infrastructure/queue/core/worker.service';
import { JobScheduler } from '../../../src/infrastructure/queue/types';
import { QueueError } from '../../../src/types/errors.type';
import { JobData } from '../../../src/types/job.type';

describe('Scheduler-Queue Integration Tests', () => {
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

  describe('Scheduled Job Processing', () => {
    test('should execute scheduled job with interval pattern', async () => {
      const processedJobs: JobData[] = [];

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(queueName, config, async (job: Job<JobData>) => {
            processedJobs.push(job.data);
          }),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            queueService.upsertJobScheduler('interval-job', {
              every: 500, // Run every 500ms
              limit: 2, // Run twice
            }),
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
      expect(processedJobs.length).toBe(2);
    });

    test('should execute scheduled job with cron pattern', async () => {
      const processedJobs: JobData[] = [];

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(queueName, config, async (job: Job<JobData>) => {
            processedJobs.push(job.data);
          }),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            queueService.upsertJobScheduler('cron-job', {
              pattern: '*/1 * * * * *', // Run every second
              limit: 2, // Run twice
            }),
            // Wait for job processing
            TE.chain(() =>
              TE.tryCatch(
                () => new Promise((resolve) => setTimeout(resolve, 3000)),
                (error) => error as QueueError,
              ),
            ),
            TE.chain(() => workerService.close()),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      expect(processedJobs.length).toBe(2);
    });

    test('should list job schedulers with pagination', async () => {
      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.chain(({ queueService }) =>
          pipe(
            // Add first scheduler
            queueService.upsertJobScheduler('scheduler-1', {
              pattern: '*/5 * * * * *',
            }),
            // Add second scheduler
            TE.chain(() =>
              queueService.upsertJobScheduler('scheduler-2', {
                every: 1000,
              }),
            ),
            // Get first page
            TE.chain(() =>
              queueService.getJobSchedulers({
                page: 1,
                pageSize: 1,
              }),
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const schedulers = result.right as JobScheduler[];
        expect(schedulers.length).toBe(1);
        expect(['scheduler-1', 'scheduler-2']).toContain(schedulers[0].jobId);
      }
    });

    test('should handle scheduler failure and recovery', async () => {
      const processedJobs: JobData[] = [];
      let attempts = 0;

      const result = await pipe(
        TE.Do,
        TE.bind('queueService', () => createQueueService<JobData>(queueName, config)),
        TE.bind('workerService', () =>
          createWorkerService<JobData>(queueName, config, async (job: Job<JobData>) => {
            attempts++;
            if (attempts === 1) {
              throw new Error('Simulated failure');
            }
            processedJobs.push(job.data);
          }),
        ),
        TE.chain(({ queueService, workerService }) =>
          pipe(
            queueService.upsertJobScheduler('failing-job', {
              every: 500,
              limit: 2,
            }),
            // Wait for job processing and retry
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
      expect(attempts).toBe(2);
      expect(processedJobs.length).toBe(1); // Second attempt should succeed
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
