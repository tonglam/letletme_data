import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import {
  createWorkerAdapter,
  MetaJobData,
  QueueOptions,
  WorkerDependencies,
} from '../../../infrastructure/queue';
import { WorkerService } from '../worker.service';

/**
 * Meta worker service interface
 */
export interface MetaWorkerService extends WorkerService {
  readonly processBootstrapJob: (job: Job<MetaJobData>) => Promise<void>;
  readonly processTeamsJob: (job: Job<MetaJobData>) => Promise<void>;
  readonly processPhasesJob: (job: Job<MetaJobData>) => Promise<void>;
}

/**
 * Creates a meta worker service
 */
export const createMetaWorkerService = (
  deps: WorkerDependencies<MetaJobData>,
  options: QueueOptions,
): MetaWorkerService => {
  const service: MetaWorkerService = {
    processBootstrapJob: async () => {
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

    processTeamsJob: async () => {
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

    processPhasesJob: async () => {
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
            case 'BOOTSTRAP':
              return pipe(
                TE.tryCatch(
                  () => service.processBootstrapJob(job),
                  (error) => error as Error,
                ),
              );
            case 'PHASES':
              return pipe(
                TE.tryCatch(
                  () => service.processPhasesJob(job),
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
