import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { getQueueLogger } from '../../../infrastructures/logger';
import { createQueueError, QueueErrorCode } from '../../../types/errors.type';
import { JobProcessor } from '../../../types/queue.type';
import { MetaJobData, MetaService } from '../../types';

const logger = getQueueLogger();

export const createMetaProcessor =
  (metaService: MetaService): JobProcessor<MetaJobData> =>
  (job: Job<MetaJobData>) =>
    pipe(
      TE.tryCatch(
        async () => {
          const { data } = job.data;
          logger.info({ jobId: job.id, operation: data.operation }, 'Processing meta job');

          switch (data.type) {
            case 'EVENTS':
              await metaService.eventsService.syncEvents()();
              break;
            case 'CLEANUP':
              await metaService.cleanup();
              break;
            default:
              throw new Error(`Unknown meta job type: ${data.type}`);
          }
        },
        (error) => createQueueError(QueueErrorCode.JOB_PROCESSING_ERROR, 'meta', error as Error),
      ),
    );
