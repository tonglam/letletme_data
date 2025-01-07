import { Job } from 'bullmq';
import { QueueError, QueueErrorCode } from '../types/error.type';
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
  code: params.code,
  context: `${params.queueName}:${params.operation}`,
  error: new Error(params.message, { cause: params.cause }),
});
