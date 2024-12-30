import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { MetaJobData } from 'src/queues/types';
import { JOB_SCHEDULES, QUEUE_CONSTANTS, QueueConfig } from '../../../configs/queue/queue.config';
import { createSchedule } from '../../../infrastructures/queue/utils';
import {
  JobOperationType,
  MetaJobType,
  QueueError,
  QueueOperation,
} from '../../../types/errors.type';
import { createQueueProcessingError } from '../../../utils/error.util';
import { processBootstrap } from '../processors/meta/bootstrap.processor';
import { processEvents } from '../processors/meta/events.processor';

// Job type processor map
const processors: Record<
  MetaJobType,
  (data: MetaJobData['data']) => TE.TaskEither<QueueError, void>
> = {
  [MetaJobType.BOOTSTRAP]: processBootstrap,
  [MetaJobType.EVENTS]: processEvents,
};

/**
 * Process meta job
 */
export const processMetaJob = (job: Job<MetaJobData>): TE.TaskEither<QueueError, void> =>
  pipe(
    O.fromNullable(processors[job.data.type]),
    O.fold(
      () =>
        TE.left(
          createQueueProcessingError({
            message: `Unknown meta job type: ${job.data.type}`,
            queueName: 'meta',
            operation: QueueOperation.PROCESS_JOB,
          }),
        ),
      (processor) => processor(job.data.data),
    ),
  );

/**
 * Create meta job schedule configuration
 */
const createMetaScheduleConfig = (config: QueueConfig): TE.TaskEither<QueueError, void> =>
  pipe(
    createSchedule(
      config,
      JOB_SCHEDULES.META_UPDATE,
      {
        type: MetaJobType.BOOTSTRAP,
        timestamp: new Date(),
        data: {
          operation: JobOperationType.SYNC,
        },
      } as MetaJobData,
      {
        priority: QUEUE_CONSTANTS.PRIORITIES.HIGH,
        attempts: QUEUE_CONSTANTS.ATTEMPTS.HIGH,
      },
    ),
  );

/**
 * Setup meta job schedules
 */
export const setupMetaSchedules = (config: QueueConfig): TE.TaskEither<QueueError, void> =>
  pipe(
    createMetaScheduleConfig(config),
    TE.map(() => undefined),
  );
