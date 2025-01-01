import { Job } from 'bullmq';
import { QueueError, QueueErrorCode } from '../types/errors.type';
import { BaseJobData } from '../types/queue.type';

/**
 * Creates a standardized queue error
 */
export const createStandardQueueError = (params: {
  code: QueueErrorCode;
  message: string;
  queueName: string;
  operation: string;
  job?: Job<BaseJobData>;
  cause?: Error;
}): QueueError => ({
  type: 'QUEUE_ERROR',
  code: params.code,
  message: params.message,
  queueName: params.queueName,
  cause: params.cause,
});
