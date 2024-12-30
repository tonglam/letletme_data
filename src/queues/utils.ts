import { Job } from 'bullmq';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { QueueError, QueueErrorCode, QueueOperation, createQueueError } from '../types/errors.type';
import { BaseJobData } from './types';

/**
 * Creates a standardized queue error with consistent formatting
 */
export const createStandardQueueError = (params: {
  code: QueueErrorCode;
  message: string;
  queueName: string;
  operation: QueueOperation;
  job?: Job<BaseJobData>;
  cause?: Error;
}): QueueError => createQueueError(params);

/**
 * Creates a queue operation error
 */
export const createQueueOperationError = (params: {
  operation: QueueOperation;
  queueName: string;
  error: Error;
  job?: Job<BaseJobData>;
}): QueueError =>
  createStandardQueueError({
    code: QueueErrorCode.PROCESSING_ERROR,
    message: `Queue operation failed: ${params.error.message}`,
    queueName: params.queueName,
    operation: params.operation,
    job: params.job,
    cause: params.error,
  });

/**
 * Creates a queue validation error
 */
export const createQueueValidationError = (params: {
  message: string;
  queueName: string;
  operation: QueueOperation;
  job?: Job<BaseJobData>;
  cause?: Error;
}): QueueError =>
  createStandardQueueError({
    code: QueueErrorCode.VALIDATION_ERROR,
    ...params,
  });

/**
 * Creates a queue connection error
 */
export const createQueueConnectionError = (params: {
  message: string;
  queueName: string;
  operation: QueueOperation;
  job?: Job<BaseJobData>;
  cause?: Error;
}): QueueError =>
  createStandardQueueError({
    code: QueueErrorCode.CONNECTION_ERROR,
    ...params,
  });

/**
 * Creates a queue timeout error
 */
export const createQueueTimeoutError = (params: {
  message: string;
  queueName: string;
  operation: QueueOperation;
  job?: Job<BaseJobData>;
  cause?: Error;
}): QueueError =>
  createStandardQueueError({
    code: QueueErrorCode.TIMEOUT_ERROR,
    ...params,
  });

/**
 * Handles a queue operation with proper error handling
 */
export const handleQueueOperation = <T>({
  operation,
  queueName,
  task,
}: {
  operation: QueueOperation;
  queueName: string;
  task: () => Promise<T>;
}): TE.TaskEither<QueueError, T> =>
  TE.tryCatch(
    task,
    (error): QueueError =>
      createStandardQueueError({
        code: QueueErrorCode.PROCESSING_ERROR,
        message: `Failed to perform ${operation}`,
        queueName,
        operation,
        cause: error as Error,
      }),
  );

/**
 * Handles job processing with proper error handling
 */
export const handleJobProcessing = <T extends BaseJobData>(params: {
  queueName: string;
  job: Job<T>;
  processor: () => Promise<void>;
}): TE.TaskEither<QueueError, void> =>
  pipe(
    TE.tryCatch(
      () => params.processor(),
      (error) =>
        createQueueOperationError({
          operation: QueueOperation.PROCESS_JOB,
          queueName: params.queueName,
          error: error as Error,
          job: params.job,
        }),
    ),
  );
