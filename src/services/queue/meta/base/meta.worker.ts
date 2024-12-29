import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import {
  createWorkerAdapter,
  MetaJobData,
  QUEUE_JOB_TYPES,
  QueueOptions,
  WorkerDependencies,
} from '../../../../infrastructure/queue';
import { WorkerService } from '../../worker.service';

// Meta worker service interface for processing various job types
export interface MetaWorkerService extends WorkerService {
  processBootstrapJob: (job: Job<MetaJobData>) => Promise<void>;
  processTeamsJob: (job: Job<MetaJobData>) => Promise<void>;
  processPhasesJob: (job: Job<MetaJobData>) => Promise<void>;
  processEventsJob: (job: Job<MetaJobData>) => Promise<void>;
}

// Creates a meta worker service with the provided dependencies
export const createMetaWorkerService = (
  deps: WorkerDependencies<MetaJobData>,
  options: QueueOptions,
): MetaWorkerService => {
  const service: MetaWorkerService = {
    processBootstrapJob: async (_job: Job<MetaJobData>) => {
      await pipe(
        TE.right(undefined),
        TE.fold(
          (error) => {
            throw error;
          },
          () => TE.right(undefined),
        ),
      )();
    },

    processTeamsJob: async (_job: Job<MetaJobData>) => {
      await pipe(
        TE.right(undefined),
        TE.fold(
          (error) => {
            throw error;
          },
          () => TE.right(undefined),
        ),
      )();
    },

    processPhasesJob: async (_job: Job<MetaJobData>) => {
      await pipe(
        TE.right(undefined),
        TE.fold(
          (error) => {
            throw error;
          },
          () => TE.right(undefined),
        ),
      )();
    },

    processEventsJob: async (_job: Job<MetaJobData>) => {
      await pipe(
        TE.right(undefined),
        TE.fold(
          (error) => {
            throw error;
          },
          () => TE.right(undefined),
        ),
      )();
    },

    ...createWorkerAdapter<MetaJobData>(
      {
        prefix: 'letletme',
        ...options,
      },
      {
        process: (job: Job<MetaJobData>) => {
          switch (job.data.type) {
            case QUEUE_JOB_TYPES.BOOTSTRAP:
              return pipe(
                TE.tryCatch(
                  () => service.processBootstrapJob(job),
                  (error) => error as Error,
                ),
              );
            case QUEUE_JOB_TYPES.PHASES:
              return pipe(
                TE.tryCatch(
                  () => service.processPhasesJob(job),
                  (error) => error as Error,
                ),
              );
            case QUEUE_JOB_TYPES.EVENTS:
              return pipe(
                TE.tryCatch(
                  () => service.processEventsJob(job),
                  (error) => error as Error,
                ),
              );
            case QUEUE_JOB_TYPES.TEAMS:
              return pipe(
                TE.tryCatch(
                  () => service.processTeamsJob(job),
                  (error) => error as Error,
                ),
              );
            default:
              return TE.left(new Error(`Unknown job type: ${job.data.type}`));
          }
        },
      },
    ),
  };

  return service;
};
