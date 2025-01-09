import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getQueueLogger } from '../../infrastructure/logger';
import { QueueError } from '../../types/error.type';
import { EventMetaService, MetaJobData, MetaService } from '../../types/job.type';
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
          { jobId: job.id, attemptsMade: job.attemptsMade, data: job.data },
          `Starting events sync, attempt ${job.attemptsMade + 1}`,
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
          `Failed to process event sync on attempt ${job.attemptsMade + 1}`,
        );
        return error;
      }),
    );

// Create event-specific meta queue service
export const createEventMetaQueueService = (eventMetaService: EventMetaService) =>
  pipe(
    TE.tryCatch(
      async () => {
        logger.info('Creating event meta queue service');
        const queueServiceResult = await createMetaQueueService(
          eventMetaService,
          createMetaJobProcessor({
            EVENTS: processEventSync(eventMetaService),
          }),
        )();

        if (E.isLeft(queueServiceResult)) {
          logger.error({ error: queueServiceResult.left }, 'Failed to create queue service');
          throw queueServiceResult.left;
        }

        logger.info('Event meta queue service created successfully');
        return queueServiceResult.right;
      },
      (error) => {
        logger.error({ error }, 'Failed to create event meta queue service');
        return error as QueueError;
      },
    ),
  );
