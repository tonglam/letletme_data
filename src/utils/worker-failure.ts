import { UnrecoverableError } from 'bullmq';

type RetryableJob = {
  attemptsMade: number;
  opts: { attempts?: number };
};

export function isTerminalJobFailure(job: RetryableJob, error: unknown): boolean {
  return (
    error instanceof UnrecoverableError ||
    (error instanceof Error && error.name === 'UnrecoverableError') ||
    job.attemptsMade >= (job.opts.attempts ?? 1)
  );
}
