import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { logger } from '../../logger/logger';
import { CacheError, CacheErrorType, DEFAULT_RETRY_CONFIG, RetryConfig } from '../types';

const calculateRetryDelay = (attempt: number, config: RetryConfig): number =>
  Math.min(config.retryDelay * Math.pow(2, attempt - 1), config.maxDelay);

const isRetryableError = (error: CacheError): boolean =>
  error.type === CacheErrorType.CONNECTION || error.type === CacheErrorType.OPERATION;

const shouldWarnOnly = (error: CacheError): boolean =>
  error.type === CacheErrorType.OPERATION || error.type === CacheErrorType.WARMING;

const logError = (error: CacheError, source: string): TE.TaskEither<CacheError, void> => {
  const logContext = {
    type: error.type,
    cause: error.cause,
    source,
    ...error.context,
  };

  return TE.fromIO(() =>
    shouldWarnOnly(error)
      ? logger.warn({ message: error.message, context: logContext })()
      : logger.error({ message: error.message, context: logContext })(),
  );
};

const logFinalError = (error: CacheError): TE.TaskEither<CacheError, void> =>
  TE.fromIO(() =>
    logger.error({
      message: 'Final cache error after retries',
      context: {
        type: error.type,
        message: error.message,
        cause: error.cause,
        source: 'retryOperation',
        ...error.context,
      },
    })(),
  );

const createTimeoutPromise = (ms: number): Promise<never> =>
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms),
  );

const withTimeout = <T>(operation: Promise<T>, timeout: number): Promise<T> =>
  Promise.race([operation, createTimeoutPromise(timeout)]);

const retryOperation = <T>(
  operation: () => TE.TaskEither<CacheError, T>,
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): TE.TaskEither<CacheError, T> => {
  const delay = calculateRetryDelay(attempt, config);
  const timeout = config.timeout ?? 5000;

  return pipe(
    TE.tryCatch(
      () =>
        withTimeout(
          new Promise((resolve) => setTimeout(resolve, delay)).then(() => operation()()),
          timeout,
        ),
      (error): CacheError => ({
        type: CacheErrorType.OPERATION,
        message: error instanceof Error ? error.message : 'Unknown error during retry',
        cause: error,
        context: { attempt, delay, timeout },
      }),
    ),
    TE.chain((result) => ('left' in result ? TE.left(result.left) : TE.right(result.right))),
    TE.orElse((error) => handleError(error, operation, attempt + 1, config)),
  );
};

export const handleError = <T>(
  error: CacheError,
  operation: () => TE.TaskEither<CacheError, T>,
  attempt: number = 1,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): TE.TaskEither<CacheError, T> => {
  const errorWithContext: CacheError = {
    ...error,
    context: {
      ...error.context,
      attempt,
      retryConfig: {
        maxRetries: config.maxRetries,
        currentAttempt: attempt,
      },
    },
  };

  return pipe(
    logError(errorWithContext, 'handleError'),
    TE.chain(() => {
      if (isRetryableError(error) && attempt <= config.maxRetries) {
        return retryOperation(operation, attempt, config);
      }
      return pipe(
        logFinalError(errorWithContext),
        TE.chain(() => TE.left(errorWithContext)),
      );
    }),
  );
};
