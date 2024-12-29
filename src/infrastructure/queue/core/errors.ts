import { Job } from 'bullmq';
import { BaseJobData } from '../types';

// Queue error codes enumeration
export enum QueueErrorCode {
  CONNECTION_ERROR = 'QUEUE_CONNECTION_ERROR',
  PROCESSING_ERROR = 'QUEUE_PROCESSING_ERROR',
  VALIDATION_ERROR = 'QUEUE_VALIDATION_ERROR',
  TIMEOUT_ERROR = 'QUEUE_TIMEOUT_ERROR',
}

// Queue error interface
export interface QueueError extends Error {
  code: QueueErrorCode;
  job?: Job<BaseJobData>;
  cause?: Error;
}

// Creates a queue connection error
export const createQueueConnectionError = (params: {
  message: string;
  cause?: Error;
}): QueueError => ({
  name: 'QueueConnectionError',
  message: params.message,
  code: QueueErrorCode.CONNECTION_ERROR,
  cause: params.cause,
});

// Creates a queue processing error
export const createQueueProcessingError = (params: {
  message: string;
  job?: Job<BaseJobData>;
  cause?: Error;
}): QueueError => ({
  name: 'QueueProcessingError',
  message: params.message,
  code: QueueErrorCode.PROCESSING_ERROR,
  job: params.job,
  cause: params.cause,
});

// Creates a queue validation error
export const createQueueValidationError = (params: {
  message: string;
  job?: Job<BaseJobData>;
  cause?: Error;
}): QueueError => ({
  name: 'QueueValidationError',
  message: params.message,
  code: QueueErrorCode.VALIDATION_ERROR,
  job: params.job,
  cause: params.cause,
});

// Creates a queue timeout error
export const createQueueTimeoutError = (params: {
  message: string;
  job?: Job<BaseJobData>;
  cause?: Error;
}): QueueError => ({
  name: 'QueueTimeoutError',
  message: params.message,
  code: QueueErrorCode.TIMEOUT_ERROR,
  job: params.job,
  cause: params.cause,
});
