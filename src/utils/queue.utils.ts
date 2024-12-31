import { Job } from 'bullmq';
import { QueueError, QueueErrorCode } from '../types/errors.type';
import { BaseJobData } from '../types/queue.type';
import { QueueOperation } from '../types/shared.type';

/**
 * Creates a standardized queue error
 */
export const createStandardQueueError = (params: {
  code: QueueErrorCode;
  message: string;
  queueName: string;
  operation: QueueOperation;
  job?: Job<BaseJobData>;
  cause?: Error;
}): QueueError => ({
  name: 'QueueError',
  stack: new Error().stack,
  timestamp: new Date(),
  ...params,
});
