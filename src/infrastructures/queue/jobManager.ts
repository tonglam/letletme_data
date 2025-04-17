import crypto from 'crypto';

import { Job, JobsOptions, Queue, RepeatOptions } from 'bullmq';

import { BaseJobPayload } from '../../types/jobs.type';
import { getQueueLogger } from '../logger';

const logger = getQueueLogger();

const generateRepeatableJobKey = (jobName: string, repeat: RepeatOptions): string => {
  const keyData = JSON.stringify({ jobName, repeat }, Object.keys(repeat).sort());
  const hash = crypto.createHash('sha256').update(keyData).digest('hex');
  return `repeat:${jobName}:${hash.substring(0, 16)}`;
};

export const addJob = async <P extends BaseJobPayload>(
  queue: Queue<P>,
  jobName: string,
  data: P,
  options?: JobsOptions,
): Promise<Job<P>> => {
  try {
    const job = await queue.add(jobName as ExtractNameType<P, string>, data, options);
    logger.info(`Job added: [${queue.name}] Name=${jobName}, ID=${job.id}`);
    return job;
  } catch (error) {
    logger.error(`Failed to add job to queue [${queue.name}]`, { jobName, error });
    throw error;
  }
};

export const addRepeatableJob = async <P extends BaseJobPayload>(
  queue: Queue<P>,
  jobName: string,
  data: P,
  repeat: RepeatOptions,
  options?: Omit<JobsOptions, 'repeat' | 'jobId' | 'removeOnComplete' | 'removeOnFail'>,
): Promise<Job<P> | void> => {
  const repeatableJobId = generateRepeatableJobKey(jobName, repeat);

  const jobOptions: JobsOptions = {
    ...options,
    jobId: repeatableJobId,
    repeat,
    removeOnComplete: undefined,
    removeOnFail: undefined,
  };

  try {
    const job = await queue.add(jobName, data, jobOptions);
    logger.info(
      `Repeatable job added/updated: [${queue.name}] Name=${jobName}, Key=${repeatableJobId}`,
    );
    return job;
  } catch (error) {
    logger.error(`Failed to add/update repeatable job [${queue.name}]`, {
      jobName,
      repeatableJobId,
      error,
    });
    throw error;
  }
};

export const removeRepeatableJob = async <P extends BaseJobPayload>(
  queue: Queue<P>,
  jobName: string,
  repeat: RepeatOptions,
): Promise<boolean> => {
  const repeatableJobKey = generateRepeatableJobKey(jobName, repeat);
  try {
    const removed = await queue.removeRepeatableByKey(repeatableJobKey);
    if (removed) {
      logger.info(
        `Repeatable job removed: [${queue.name}] Name=${jobName}, Key=${repeatableJobKey}`,
      );
    } else {
      logger.warn(`Repeatable job not found for removal: [${queue.name}] Key=${repeatableJobKey}`);
    }
    return removed;
  } catch (error) {
    logger.error(`Failed to remove repeatable job [${queue.name}]`, {
      jobName,
      repeatableJobKey,
      error,
    });
    throw error;
  }
};

export const removeJob = async <P extends BaseJobPayload>(
  queue: Queue<P>,
  jobId: string,
): Promise<void> => {
  try {
    const job = await queue.getJob(jobId);
    if (job) {
      await job.remove();
      logger.info(`Job instance removed: [${queue.name}] ID=${jobId}`);
    } else {
      logger.warn(`Job instance not found for removal: [${queue.name}] ID=${jobId}`);
    }
  } catch (error) {
    logger.error(`Failed to remove job instance [${queue.name}]`, { jobId, error });
    throw error;
  }
};
