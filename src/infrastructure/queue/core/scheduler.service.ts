import { Queue } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createQueueError, QueueError, QueueErrorCode } from '../../../types/errors.type';
import { BaseJobData } from '../../../types/job.type';
import { getQueueLogger } from '../../logger';
import { JobScheduler, JobSchedulerOptions, JobTemplate, SchedulerService } from '../types';

const logger = getQueueLogger();

const mapToJobScheduler = (job: { key: string; nextRun?: Date; lastRun?: Date }): JobScheduler => ({
  jobId: job.key.split(':')[0],
  nextRun: job.nextRun,
  lastRun: job.lastRun,
});

export const createSchedulerService = <T extends BaseJobData>(
  name: string,
  queue: Queue<T>,
): SchedulerService<T> => {
  const upsertJobScheduler = (
    schedulerId: string,
    scheduleOptions: JobSchedulerOptions,
    template?: JobTemplate<T>,
  ): TE.TaskEither<QueueError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await queue.add(
            template?.name || schedulerId,
            (template?.data || {
              type: 'META',
              timestamp: new Date(),
              data: {},
            }) as T,
            {
              ...template?.opts,
              jobId: schedulerId,
              repeat: {
                pattern: scheduleOptions.pattern,
                every: scheduleOptions.every,
                limit: scheduleOptions.limit,
              },
            },
          );
          logger.info({ name, schedulerId, scheduleOptions }, 'Job scheduler created/updated');
        },
        (error) => createQueueError(QueueErrorCode.CREATE_JOB_SCHEDULER, name, error as Error),
      ),
    );

  const getJobSchedulers = (options?: {
    page?: number;
    pageSize?: number;
  }): TE.TaskEither<QueueError, JobScheduler[]> =>
    pipe(
      TE.tryCatch(
        async () => {
          // Get all repeatable jobs first
          const allJobs = await queue.getRepeatableJobs();

          // Then handle pagination in memory
          if (options?.page && options?.pageSize) {
            const start = (options.page - 1) * options.pageSize;
            const end = start + options.pageSize;
            return allJobs.slice(start, end).map(mapToJobScheduler);
          }

          return allJobs.map(mapToJobScheduler);
        },
        (error) => createQueueError(QueueErrorCode.GET_JOB_SCHEDULERS, name, error as Error),
      ),
    );

  return {
    upsertJobScheduler,
    getJobSchedulers,
  };
};