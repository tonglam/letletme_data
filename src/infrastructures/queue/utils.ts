import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { BaseJobData, JobMetricsData, QueueError, WorkerMetrics } from './types';

// Error creation utilities
export const createQueueError = (
  message: string,
  queueName: string,
  operation: string,
  cause?: Error,
): QueueError => ({
  name: 'QueueError',
  message,
  queueName,
  operation,
  cause,
});

// Job utilities
export const isJobValid = <T extends BaseJobData>(job: Job<T>): boolean =>
  pipe(
    O.fromNullable(job),
    O.map((j) => Boolean(j.id && j.data)),
    O.getOrElse(() => false),
  );

// Metrics utilities
export const calculateWorkerMetrics = (
  metrics: ReadonlyArray<JobMetricsData>,
): TE.TaskEither<Error, WorkerMetrics> =>
  pipe(
    TE.right(metrics),
    TE.map((data) => ({
      processedCount: data.filter((m) => m.status === 'completed').length,
      failedCount: data.filter((m) => m.status === 'failed').length,
      activeCount: data.filter((m) => m.status === 'active').length,
      completedCount: data.filter((m) => m.status === 'completed').length,
      stallCount: 0, // This would need to be tracked separately
      waitTimeAvg: calculateAverageWaitTime(data),
    })),
  );

// Helper function for calculating average wait time
const calculateAverageWaitTime = (metrics: ReadonlyArray<JobMetricsData>): number =>
  pipe(
    metrics,
    (data) => data.reduce((acc, curr) => acc + curr.duration, 0),
    (total) => (metrics.length > 0 ? total / metrics.length : 0),
  );

// Rate limiting utilities
export const checkRateLimit = (
  currentCount: number,
  rateLimit: { max: number; duration: number },
): TE.TaskEither<QueueError, void> =>
  pipe(
    currentCount >= rateLimit.max
      ? TE.left(
          createQueueError(
            `Rate limit exceeded: ${currentCount}/${rateLimit.max}`,
            'rate-limiter',
            'check-rate-limit',
          ),
        )
      : TE.right(undefined),
  );

// Job operation utilities
export const retryOperation = <T>(
  operation: () => Promise<T>,
  retries: number,
  delay: number,
): TE.TaskEither<Error, T> => {
  const retry = (attemptsLeft: number): TE.TaskEither<Error, T> =>
    pipe(
      TE.tryCatch(
        () => operation(),
        (error) => error as Error,
      ),
      TE.fold(
        (error) =>
          attemptsLeft > 0
            ? pipe(
                TE.fromIO(() => new Promise((resolve) => setTimeout(resolve, delay))),
                TE.chain(() => retry(attemptsLeft - 1)),
              )
            : TE.left(error),
        (result) => TE.right(result),
      ),
    );

  return retry(retries);
};

// Logging utilities
export const createStructuredLog = (
  operation: string,
  status: 'success' | 'error',
  details: Record<string, unknown>,
): Record<string, unknown> => ({
  timestamp: new Date().toISOString(),
  operation,
  status,
  ...details,
});
