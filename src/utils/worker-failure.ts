import { UnrecoverableError } from 'bullmq';

type RetryableJob = {
  attemptsMade: number;
  opts: { attempts?: number };
};

function isUnrecoverableFailure(error: unknown): boolean {
  return (
    error instanceof UnrecoverableError ||
    (error instanceof Error && error.name === 'UnrecoverableError')
  );
}

export function isTerminalJobAttemptFailure(
  job: RetryableJob,
  error: unknown,
  attempt = job.attemptsMade + 1,
): boolean {
  return isUnrecoverableFailure(error) || attempt >= Math.max(1, job.opts.attempts ?? 1);
}

export function isTerminalJobFailure(job: RetryableJob, error: unknown): boolean {
  return isTerminalJobAttemptFailure(job, error, job.attemptsMade);
}
