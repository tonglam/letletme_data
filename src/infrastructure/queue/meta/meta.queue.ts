import { Job } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { QueueService } from '../../../jobs/queue.service';
import { createQueueAdapter } from '../core';
import { QUEUE_JOB_TYPES } from '../core/constants';
import { JobOperation, MetaJobData, QueueDependencies } from '../types';

// Meta queue service interface for managing meta jobs
export interface MetaQueueService extends QueueService<MetaJobData> {
  scheduleBootstrapJob: () => TE.TaskEither<Error, Job<MetaJobData>>;
  scheduleTeamsJob: () => TE.TaskEither<Error, Job<MetaJobData>>;
  schedulePhasesJob: () => TE.TaskEither<Error, Job<MetaJobData>>;
  scheduleEventsJob: () => TE.TaskEither<Error, Job<MetaJobData>>;
}

// Creates a meta queue service with the provided dependencies
export const createMetaQueueService = (deps: QueueDependencies): MetaQueueService => {
  const adapter = createQueueAdapter<MetaJobData>(deps);

  const service: MetaQueueService = {
    ...adapter,

    scheduleBootstrapJob: () =>
      pipe(
        TE.right(undefined),
        TE.chain(() =>
          service.add({
            type: QUEUE_JOB_TYPES.BOOTSTRAP,
            timestamp: new Date(),
            data: {
              operation: JobOperation.SYNC,
            },
          }),
        ),
      ),

    scheduleTeamsJob: () =>
      pipe(
        TE.right(undefined),
        TE.chain(() =>
          service.add({
            type: QUEUE_JOB_TYPES.TEAMS,
            timestamp: new Date(),
            data: {
              operation: JobOperation.SYNC,
            },
          }),
        ),
      ),

    schedulePhasesJob: () =>
      pipe(
        TE.right(undefined),
        TE.chain(() =>
          service.add({
            type: QUEUE_JOB_TYPES.PHASES,
            timestamp: new Date(),
            data: {
              operation: JobOperation.SYNC,
            },
          }),
        ),
      ),

    scheduleEventsJob: () =>
      pipe(
        TE.right(undefined),
        TE.chain(() =>
          service.add({
            type: QUEUE_JOB_TYPES.EVENTS,
            timestamp: new Date(),
            data: {
              operation: JobOperation.SYNC,
            },
          }),
        ),
      ),
  };

  return service;
};
