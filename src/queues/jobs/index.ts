import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueConfig } from '../../configs/queue/queue.config';
import { QueueError } from '../../types/errors.type';
import { createMetaJobService, MetaJobService, MetaService } from './meta.job';

export interface JobServices {
  readonly meta: MetaJobService;
}

export const createJobServices = (
  configs: {
    meta: QueueConfig;
  },
  services: {
    meta: MetaService;
  },
): TE.TaskEither<QueueError, JobServices> =>
  pipe(
    TE.Do,
    TE.bind('meta', () => createMetaJobService(configs.meta, services.meta)),
    TE.map(({ meta }) => ({
      meta,
    })),
  );

// Usage example:
// const jobServices = await createJobServices(
//   { meta: metaQueueConfig },
//   { meta: metaService },
// )();
//
// // Start worker
// await jobServices.meta.queueService.startWorker()();
//
// // Schedule jobs
// await jobServices.meta.scheduleEventsSync()();
