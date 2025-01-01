import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { BaseJobData, JobProcessor } from '../../../infrastructures/queue/types';
import { createQueueError } from '../../../infrastructures/queue/utils';
import { QueueError, QueueErrorCode } from '../../../types/errors.type';

export interface MetaService {
  readonly sync: () => TE.TaskEither<Error, void>;
  readonly cleanup: () => TE.TaskEither<Error, void>;
}

export type MetaJobType = 'BOOTSTRAP' | 'CLEANUP';

export interface MetaJobData extends BaseJobData {
  readonly type: MetaJobType;
  readonly data: {
    readonly operation: 'SYNC' | 'CLEANUP';
  };
}

export const createMetaProcessor = (metaService: MetaService): JobProcessor<MetaJobData> => {
  return (job: Job<MetaJobData>): TE.TaskEither<QueueError, void> => {
    const { type, data } = job.data;

    switch (type) {
      case 'BOOTSTRAP':
        if (data.operation === 'SYNC') {
          return pipe(
            metaService.sync(),
            TE.mapLeft((error) =>
              createQueueError({
                code: QueueErrorCode.JOB_PROCESSING_ERROR,
                message: 'Failed to process bootstrap sync job',
                queueName: job.queueName,
                cause: error,
              }),
            ),
          );
        }
        break;
      case 'CLEANUP':
        if (data.operation === 'CLEANUP') {
          return pipe(
            metaService.cleanup(),
            TE.mapLeft((error) =>
              createQueueError({
                code: QueueErrorCode.JOB_PROCESSING_ERROR,
                message: 'Failed to process cleanup job',
                queueName: job.queueName,
                cause: error,
              }),
            ),
          );
        }
        break;
    }

    return TE.left(
      createQueueError({
        code: QueueErrorCode.INVALID_JOB_DATA,
        message: `Invalid job type or operation: ${type} - ${data.operation}`,
        queueName: job.queueName,
      }),
    );
  };
};
