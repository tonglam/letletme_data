import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getQueueLogger } from '../../../infrastructures/logger';
import { EventWorkflows } from '../../../services/events/workflow';
import { QueueErrorCode, createQueueError } from '../../../types/errors.type';
import { JobProcessor } from '../../../types/queue.type';
import { createQueueProcessingError } from '../../../utils/error.util';
import { MetaJobData } from '../../types';

const logger = getQueueLogger();

export const createEventsProcessor =
  (eventWorkflows: EventWorkflows): JobProcessor<MetaJobData> =>
  (job: Job<MetaJobData>) =>
    pipe(
      TE.tryCatch(
        async () => {
          const { data } = job.data;
          logger.info({ jobId: job.id, operation: data.operation }, 'Processing events job');

          if (data.type !== 'EVENTS') {
            throw new Error('Invalid job type for events processor');
          }

          let result;
          switch (data.operation) {
            case 'SYNC':
              result = await eventWorkflows.syncEvents()();
              if (result._tag === 'Left') {
                throw createQueueProcessingError({
                  message: `Event sync failed: ${result.left.message}`,
                  queueName: 'meta',
                  cause: result.left,
                });
              }
              break;
            default:
              throw new Error(`Unknown operation: ${data.operation}`);
          }
        },
        (error) => {
          if (error instanceof Error) {
            return createQueueError(QueueErrorCode.JOB_PROCESSING_ERROR, 'meta', error);
          }
          return createQueueProcessingError({
            message: 'Unknown error during job processing',
            queueName: 'meta',
          });
        },
      ),
    );
