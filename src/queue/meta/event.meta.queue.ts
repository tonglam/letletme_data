import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getQueueLogger } from '../../infrastructure/logger';
import { QueueError } from '../../types/errors.type';
import { EventMetaService, MetaJobData, MetaService } from '../../types/job.type';
import { QueueConnection } from '../../types/queue.type';
import { createMetaJobProcessor, createMetaQueueService } from './meta.queue';

const logger = getQueueLogger();

// Event-specific job processor
const processEventSync =
  (eventService: EventMetaService) =>
  (
    job: Job<MetaJobData>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    metaService: MetaService,
  ): TE.TaskEither<QueueError, void> =>
    pipe(
      TE.Do,
      TE.chain(() => {
        logger.info({ jobId: job.id }, 'Starting events sync');
        return eventService.syncEvents();
      }),
      TE.map(() => {
        logger.info({ jobId: job.id }, 'Events sync completed');
      }),
      TE.mapLeft((error: QueueError) => {
        logger.error({ error }, 'Failed to process event sync');
        return error;
      }),
    );

// Create event-specific meta queue service
export const createEventMetaQueueService = (
  config: { connection: QueueConnection },
  eventMetaService: EventMetaService,
) =>
  createMetaQueueService(
    config,
    eventMetaService,
    createMetaJobProcessor({
      EVENTS: processEventSync(eventMetaService),
    }),
  );
