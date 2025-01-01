import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { QueueConfig } from '../../configs/queue/queue.config';
import { getQueueLogger } from '../../infrastructures/logger';
import { createQueueService, QueueService } from '../../infrastructures/queue/core/queue.service';
import { createQueueError, QueueError, QueueErrorCode } from '../../types/errors.type';
import { JobProcessor, JobType } from '../../types/queue.type';
import { EventsJobService } from './events/events.service';

const logger = getQueueLogger();

// Types
export type MetaJobType = 'EVENTS' | 'CLEANUP';
export type MetaJobOperation = 'SYNC' | 'CLEANUP';

export interface MetaJobData {
  readonly type: JobType.META;
  readonly timestamp: Date;
  readonly data: {
    readonly operation: MetaJobOperation;
    readonly type: MetaJobType;
  };
}

// Service interface
export interface MetaService {
  readonly eventsService: EventsJobService;
  readonly cleanup: () => Promise<void>;
}

// Job processor
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

// Meta Job Service
export interface MetaJobService {
  readonly queueService: QueueService<MetaJobData>;
  readonly scheduleEventsSync: () => TE.TaskEither<QueueError, void>;
  readonly scheduleCleanup: () => TE.TaskEither<QueueError, void>;
}

export const createMetaJobService = (
  config: QueueConfig,
  metaService: MetaService,
): TE.TaskEither<QueueError, MetaJobService> =>
  pipe(
    createQueueService(config, createMetaProcessor(metaService)),
    TE.map((queueService) => ({
      queueService,
      scheduleEventsSync: () =>
        queueService.addJob({
          type: JobType.META,
          timestamp: new Date(),
          data: {
            operation: 'SYNC',
            type: 'EVENTS',
          },
        }),
      scheduleCleanup: () =>
        queueService.addJob({
          type: JobType.META,
          timestamp: new Date(),
          data: {
            operation: 'CLEANUP',
            type: 'CLEANUP',
          },
        }),
    })),
  );
