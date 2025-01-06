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
        logger.info(
          { jobId: job.id, attemptsMade: job.attemptsMade },
          'Starting events sync, attempt ${job.attemptsMade + 1}',
        );
        return eventService.syncEvents();
      }),
      TE.map(() => {
        logger.info(
          { jobId: job.id, attemptsMade: job.attemptsMade },
          'Events sync completed successfully',
        );
      }),
      TE.mapLeft((error: QueueError) => {
        logger.error(
          { error, jobId: job.id, attemptsMade: job.attemptsMade },
          'Failed to process event sync on attempt ${job.attemptsMade + 1}',
        );
        return error;
      }),
    );

// Create event-specific meta queue service
export const createEventMetaQueueService = (
  config: { connection: QueueConnection },
  eventMetaService: EventMetaService,
) =>
  pipe(
    createMetaQueueService(
      config,
      eventMetaService,
      createMetaJobProcessor({
        EVENTS: processEventSync(eventMetaService),
      }),
    ),
    TE.map((service) => {
      logger.info('Event meta queue service created successfully');
      return service;
    }),
    TE.mapLeft((error) => {
      logger.error({ error }, 'Failed to create event meta queue service');
      return error;
    }),
  );
