import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getQueueLogger } from '../../../../infrastructures/logger';
import { createQueueError, QueueError, QueueErrorCode } from '../../../../types/errors.type';
import { JobProcessor } from '../../../../types/queue.type';
import { MetaJobData, MetaService } from '../../../types';

const logger = getQueueLogger();

export const createMetaProcessor = (service: MetaService): JobProcessor<MetaJobData> => {
  return (job: Job<MetaJobData>): TE.TaskEither<QueueError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const { data } = job.data;
          logger.info({ jobType: job.data.type, operation: data.operation }, 'Processing meta job');

          switch (data.type) {
            case 'EVENTS':
              if (data.operation === 'SYNC') {
                await service.eventsService.syncEvents();
              }
              break;
            case 'CLEANUP':
              if (data.operation === 'CLEANUP') {
                await service.cleanup();
              }
              break;
            default:
              throw new Error(`Invalid job type: ${data.type}`);
          }
        },
        (error) => createQueueError(QueueErrorCode.JOB_PROCESSING_ERROR, 'meta', error as Error),
      ),
    );
};
