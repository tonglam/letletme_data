import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../config/queue/queue.config';
import { getQueueLogger } from '../../infrastructure/logger';
import { createQueueService } from '../../infrastructure/queue/core/queue.service';
import { JobOptions } from '../../infrastructure/queue/types';
import { createQueueError, QueueError, QueueErrorCode } from '../../types/errors.type';
import {
  MetaJobData,
  MetaOperation,
  MetaQueueService,
  MetaService,
  MetaType,
} from '../../types/job.type';

const logger = getQueueLogger();

const createMetaJobData = (operation: MetaOperation, metaType: MetaType): MetaJobData => ({
  type: 'META',
  name: 'meta',
  timestamp: new Date(),
  data: {
    operation,
    metaType,
  },
});

export const createMetaQueueService = (
  config: QueueConfig,
  metaService: MetaService,
): TE.TaskEither<QueueError, MetaQueueService> =>
  pipe(
    TE.Do,
    TE.bind('queueService', () => createQueueService<MetaJobData>('meta', config)),
    TE.map(({ queueService }) => ({
      ...queueService,
      processJob: (job: Job<MetaJobData>) =>
        pipe(
          TE.tryCatch(
            async () => {
              const { operation, metaType } = job.data.data;
              logger.info({ jobId: job.id, operation, metaType }, 'Processing meta job');

              switch (operation) {
                case 'SYNC':
                  await metaService.startWorker()();
                  break;
                case 'CLEANUP':
                  await metaService.cleanup()();
                  break;
                default:
                  throw new Error(`Unknown operation: ${operation}`);
              }
            },
            (error) => createQueueError(QueueErrorCode.PROCESSING_ERROR, 'meta', error as Error),
          ),
        ),
      startWorker: () => metaService.startWorker(),
      stopWorker: () => metaService.stopWorker(),
      syncMeta: (metaType: MetaType) =>
        pipe(createMetaJobData('SYNC', metaType), (jobData) =>
          queueService.addJob(jobData, {} as JobOptions),
        ),
      cleanupMeta: (metaType: MetaType) =>
        pipe(createMetaJobData('CLEANUP', metaType), (jobData) =>
          queueService.addJob(jobData, {} as JobOptions),
        ),
    })),
  );
