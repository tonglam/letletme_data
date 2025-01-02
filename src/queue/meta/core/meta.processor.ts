import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getQueueLogger } from '../../../infrastructure/logger';
import { createQueueError, QueueErrorCode } from '../../../types/errors.type';
import { JobProcessor } from '../../../types/queue.type';
import { MetaJobData } from '../../types';
import { type MetaService } from './types';

const logger = getQueueLogger();

export const createMetaProcessor =
  (metaService: MetaService): JobProcessor<MetaJobData> =>
  (job: Job<MetaJobData>) =>
    pipe(
      TE.tryCatch(
        async () => {
          const { data } = job.data;
          logger.info({ jobId: job.id, operation: data.operation }, 'Processing meta job');

          switch (data.operation) {
            case 'SYNC':
              await metaService.startWorker()();
              break;
            case 'CLEANUP':
              // Handle cleanup operation
              break;
            default:
              throw new Error(`Unknown operation: ${data.operation}`);
          }
        },
        (error) => createQueueError(QueueErrorCode.JOB_PROCESSING_ERROR, 'meta', error as Error),
      ),
    );
