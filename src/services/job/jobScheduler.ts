import { CronJob } from 'cron';
import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as R from 'fp-ts/Record';
import { pipe } from 'fp-ts/function';
import { JobDefinition } from '../../jobs/types';
import { createLogger } from '../../utils/logger';

// Types
type CronTimeSource = string | { toString(): string };

interface JobStatus {
  readonly registered: boolean;
  readonly running: boolean;
  readonly schedule?: string;
}

interface SchedulerState {
  readonly cronJobs: Record<string, CronJob>;
}

// Create logger
const logger = createLogger('JobScheduler');

// Initialize empty state
const createEmptyState = (): SchedulerState => ({
  cronJobs: {},
});

// Pure function to create a cron job
const createCronJob = (
  name: string,
  schedule: string,
  executeJob: () => Promise<void>,
): E.Either<Error, CronJob> =>
  E.tryCatch(
    () =>
      new CronJob(
        schedule,
        async () => {
          try {
            await executeJob();
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            logger.error({ jobName: name, error: err.message }, 'Failed to execute scheduled job');
          }
        },
        null,
        false,
        'UTC',
      ),
    (error) => new Error(`Failed to create cron job: ${error}`),
  );

// Register a scheduled job
export const registerScheduledJob = <TData = unknown, TResult = unknown>(
  state: SchedulerState,
  name: string,
  jobDefinition: JobDefinition<TData, TResult>,
  executeJob: () => Promise<void>,
): E.Either<Error, SchedulerState> =>
  pipe(
    jobDefinition.metadata.schedule
      ? E.right(jobDefinition.metadata.schedule)
      : E.left(new Error('Job has no schedule')),
    E.chain((schedule) =>
      pipe(
        createCronJob(name, schedule, executeJob),
        E.map((cronJob) => ({
          ...state,
          cronJobs: { ...state.cronJobs, [name]: cronJob },
        })),
      ),
    ),
  );

// Start all jobs
export const startAllJobs = (state: SchedulerState): E.Either<Error, SchedulerState> =>
  pipe(
    state.cronJobs,
    R.traverseWithIndex(E.Applicative)((name, job) =>
      pipe(
        E.tryCatch(
          () => {
            if (!job.running) {
              job.start();
              logger.info({ jobName: name }, 'Scheduled job started');
            } else {
              logger.warn({ jobName: name }, 'Job already running');
            }
            return job;
          },
          (error) => new Error(`Failed to start job ${name}: ${error}`),
        ),
      ),
    ),
    E.map((cronJobs) => ({ ...state, cronJobs })),
  );

// Stop all jobs
export const stopAllJobs = (state: SchedulerState): E.Either<Error, SchedulerState> =>
  pipe(
    state.cronJobs,
    R.traverseWithIndex(E.Applicative)((name, job) =>
      pipe(
        E.tryCatch(
          () => {
            if (job.running) {
              job.stop();
              logger.info({ jobName: name }, 'Scheduled job stopped');
            } else {
              logger.warn({ jobName: name }, 'Job already stopped');
            }
            return job;
          },
          (error) => new Error(`Failed to stop job ${name}: ${error}`),
        ),
      ),
    ),
    E.map((cronJobs) => ({ ...state, cronJobs })),
  );

// Get job status
export const getJobStatus = (state: SchedulerState, name: string): O.Option<JobStatus> =>
  pipe(
    O.fromNullable(state.cronJobs[name]),
    O.map((job) => {
      const source = job.cronTime?.source as CronTimeSource | undefined;
      return {
        registered: true,
        running: job.running,
        schedule: source?.toString(),
      };
    }),
  );

// Create the scheduler
export const createScheduler = (): SchedulerState => createEmptyState();
