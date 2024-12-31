import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { QueueError } from 'src/types/errors.type';
import { JobOperationType, JobType, MetaJobData } from 'src/types/queue.type';
import { QueueOperation } from 'src/types/shared.type';
import { JOB_SCHEDULES, QUEUE_CONSTANTS, QueueConfig } from '../../../configs/queue/queue.config';
import { createSchedule } from '../../../infrastructures/queue/utils';
import { createQueueProcessingError } from '../../../utils/error.util';
import { processEvents } from '../processors/meta/events.processor';

// Meta job types
export enum MetaJobType {
  EVENTS = 'EVENTS',
}

// Job type processor map
const processors: Record<
  MetaJobType,
  (data: MetaJobData['data']) => TE.TaskEither<QueueError, void>
> = {
  [MetaJobType.EVENTS]: processEvents,
};

/**
 * Process meta job
 */
export const processMetaJob = (job: Job<MetaJobData>): TE.TaskEither<QueueError, void> =>
  pipe(
    O.fromNullable(processors[job.data.data.type as MetaJobType]),
    O.fold(
      () =>
        TE.left(
          createQueueProcessingError({
            message: `Unknown meta job type: ${job.data.data.type}`,
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
        type: JobType.META,
        timestamp: new Date(),
        data: {
          operation: JobOperationType.CREATE,
          type: MetaJobType.EVENTS,
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
