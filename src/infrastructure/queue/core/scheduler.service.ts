import { Queue, RepeatableJob } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueError, QueueErrorCode, createQueueError } from '../../../types/errors.type';
import { JobData } from '../../../types/job.type';
import { getQueueLogger } from '../../logger';
import {
  BullMQQueueMethods,
  JobScheduler,
  JobSchedulerOptions,
  JobTemplate,
  SchedulerService,
} from '../types';

const logger = getQueueLogger();

const toJobScheduler = (job: RepeatableJob): JobScheduler => ({
  id: job.id ?? job.name,
  name: job.name,
  options: {
    every: job.every ? parseInt(job.every, 10) : undefined,
    pattern: job.pattern ?? undefined,
  },
  nextRun: job.next ? new Date(job.next) : undefined,
});

export const createSchedulerService = <T extends JobData>(
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
          const jobName = template?.name ?? schedulerId;
          const jobData = template?.data ?? ({} as T);
          const jobOpts = {
            repeat: {
              every: scheduleOptions.every,
              pattern: scheduleOptions.pattern,
            },
            jobId: schedulerId,
            priority: template?.opts?.priority,
            lifo: template?.opts?.lifo,
            delay: template?.opts?.delay,
          };

          await (queue as unknown as BullMQQueueMethods<T>).add(jobName, jobData, jobOpts);
          logger.info({ name, schedulerId, scheduleOptions }, 'Job scheduler created or updated');
        },
        (error) => createQueueError(QueueErrorCode.UPSERT_JOB_SCHEDULER, name, error as Error),
      ),
    );

  const getJobSchedulers = (
    start = 0,
    end = -1,
    asc = true,
  ): TE.TaskEither<QueueError, JobScheduler[]> =>
    pipe(
      TE.tryCatch(
        async () => {
          const repeatableJobs = await queue.getRepeatableJobs(start, end, asc);
          return repeatableJobs.map(toJobScheduler);
        },
        (error) => createQueueError(QueueErrorCode.GET_JOB_SCHEDULER, name, error as Error),
      ),
    );

  return {
    upsertJobScheduler,
    getJobSchedulers,
  };
};
