import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { WorkerService } from '../../../jobs/worker.service';
import { META_QUEUE_CONFIG } from '../config/queue.config';
import { QUEUE_LOG_MESSAGES, QUEUE_PROGRESS } from '../core/constants';
import { WorkerDependencies, createWorkerAdapter } from '../core/worker.adapter';
import { BaseJobData } from '../types';

// Common job processing wrapper that handles progress updates
// Infrastructure layer utility for progress tracking
const processWithProgress = <T extends BaseJobData>(
  job: Job<T>,
  process: () => Promise<void>,
): TE.TaskEither<Error, void> =>
  pipe(
    TE.tryCatch(
      async () => {
        await job.updateProgress(QUEUE_PROGRESS.START);
        await process();
        await job.updateProgress(QUEUE_PROGRESS.COMPLETE);
      },
      (error) => error as Error,
    ),
  );

// Creates a worker service with progress tracking
// Infrastructure layer only - handles job mechanics, error handling, and logging
export const createWorkerWithProgress = <T extends BaseJobData>(
  config: typeof META_QUEUE_CONFIG,
  processJob: (job: Job<T>) => Promise<void>,
): WorkerService => {
  const deps: WorkerDependencies<T> = {
    process: (job: Job<T>) => processWithProgress(job, () => processJob(job)),
    onCompleted: (job: Job<T>) => {
      console.log(QUEUE_LOG_MESSAGES.JOB_COMPLETED(job.id as string, config.name));
      console.log(QUEUE_LOG_MESSAGES.JOB_DATA, job.data);
    },
    onFailed: (job: Job<T>, error: Error) => {
      console.error(QUEUE_LOG_MESSAGES.JOB_FAILED(job.id as string, config.name), error);
      console.error(QUEUE_LOG_MESSAGES.JOB_DATA, job.data);
    },
    onError: (error: Error) => {
      console.error(QUEUE_LOG_MESSAGES.WORKER_ERROR(config.name), error);
    },
  };

  return createWorkerAdapter<T>(config, deps);
};

// Creates a meta worker service using the generic worker infrastructure
export const createMetaWorkerService = (
  processJob: (job: Job<BaseJobData>) => Promise<void>,
): WorkerService => createWorkerWithProgress(META_QUEUE_CONFIG, processJob);
