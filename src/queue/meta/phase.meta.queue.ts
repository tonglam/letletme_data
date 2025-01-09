import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { getQueueLogger } from '../../infrastructure/logger';
import { QueueError } from '../../types/error.type';
import { MetaJobData, MetaService, PhaseMetaService } from '../../types/job.type';
import { createMetaJobProcessor, createMetaQueueService } from './meta.queue';

const logger = getQueueLogger();

// Phase-specific job processor
const processPhaseSync =
  (phaseService: PhaseMetaService) =>
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
          `Starting phases sync, attempt ${job.attemptsMade + 1}`,
        );
        return phaseService.syncPhases();
      }),
      TE.map(() => {
        logger.info(
          { jobId: job.id, attemptsMade: job.attemptsMade },
          'Phases sync completed successfully',
        );
      }),
      TE.mapLeft((error: QueueError) => {
        logger.error(
          { error, jobId: job.id, attemptsMade: job.attemptsMade },
          `Failed to process phase sync on attempt ${job.attemptsMade + 1}`,
        );
        return error;
      }),
    );

// Create phase-specific meta queue service
export const createPhaseMetaQueueService = (phaseMetaService: PhaseMetaService) =>
  pipe(
    createMetaQueueService(
      phaseMetaService,
      createMetaJobProcessor({
        PHASES: processPhaseSync(phaseMetaService),
      }),
    ),
    TE.map((service) => {
      logger.info('Phase meta queue service created successfully');
      return service;
    }),
    TE.mapLeft((error) => {
      logger.error({ error }, 'Failed to create phase meta queue service');
      return error;
    }),
  );
