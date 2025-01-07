import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createQueueServiceImpl } from '../../../src/infrastructure/queue/core/queue.service';
import { createSchedulerService } from '../../../src/infrastructure/queue/core/scheduler.service';
import { QueueService } from '../../../src/infrastructure/queue/types';
import { QueueError, QueueErrorCode } from '../../../src/types/error.type';
import { JobName, MetaJobData } from '../../../src/types/job.type';
import { createTestMetaJobData, createTestQueueConfig } from '../../utils/queue.test.utils';

describe('Scheduler Service Tests', () => {
  const queueName = 'test-scheduler-queue';
  const defaultJobName = 'meta' as JobName;
  const config = createTestQueueConfig();

  describe('Job Scheduling', () => {
    test('should schedule job successfully', async () => {
      const result = await pipe(
        createQueueServiceImpl<MetaJobData>(queueName, config),
        TE.chain((queueService: QueueService<MetaJobData>) =>
          pipe(
            TE.right(createSchedulerService(queueName, queueService.getQueue())),
            TE.chain((schedulerService) =>
              schedulerService.upsertJobScheduler(
                'test-scheduler',
                { every: 1000 },
                {
                  name: defaultJobName,
                  data: createTestMetaJobData({ name: defaultJobName }),
                },
              ),
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
    });

    test('should get job schedulers', async () => {
      const result = await pipe(
        createQueueServiceImpl<MetaJobData>(queueName, config),
        TE.chain((queueService: QueueService<MetaJobData>) =>
          pipe(
            TE.right(createSchedulerService(queueName, queueService.getQueue())),
            TE.chain((schedulerService) =>
              pipe(
                schedulerService.upsertJobScheduler(
                  'test-scheduler',
                  { every: 1000 },
                  {
                    name: defaultJobName,
                    data: createTestMetaJobData({ name: defaultJobName }),
                  },
                ),
                TE.chain(() => schedulerService.getJobSchedulers()),
              ),
            ),
          ),
        ),
      )();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const schedulers = result.right;
        expect(schedulers.length).toBeGreaterThan(0);
      }
    });

    test('should handle invalid scheduler creation', async () => {
      const result = await pipe(
        createQueueServiceImpl<MetaJobData>(queueName, config),
        TE.chain((queueService: QueueService<MetaJobData>) =>
          pipe(
            TE.right(createSchedulerService(queueName, queueService.getQueue())),
            TE.chain((schedulerService) =>
              schedulerService.upsertJobScheduler(
                'test-scheduler',
                { pattern: 'invalid-cron' },
                {
                  name: defaultJobName,
                  data: createTestMetaJobData({ name: defaultJobName }),
                },
              ),
            ),
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
      createQueueServiceImpl<MetaJobData>(queueName, config),
      TE.chain((service: QueueService<MetaJobData>) => service.obliterate()),
    )();
    expect(cleanup._tag).toBe('Right');
  });
});
