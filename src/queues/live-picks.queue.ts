import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import type { EntrySyncJobData } from './entry-sync.queue';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';
import { livePicksQueueName } from './names';

/** Dedicated provider-heavy queue with an independent Bull connection/name. */
export const livePicksQueue = new Queue<EntrySyncJobData>(livePicksQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export async function closeLivePicksQueue(): Promise<void> {
  await livePicksQueue.close();
}

export { livePicksQueueName } from './names';
export type { EntrySyncJobData as LivePicksJobData } from './entry-sync.queue';
