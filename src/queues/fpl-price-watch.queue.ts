import { Queue } from 'bullmq';

import type { DataSyncJobData } from './data-sync.queue';
import { getQueueConnection } from '../utils/queue';
import { fplPriceWatchQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { fplPriceWatchQueueName } from './names';

export type FplPriceWatchJobData = DataSyncJobData & {
  deadlineAt: string;
  watchId: string;
};

export const fplPriceWatchQueue = new Queue<FplPriceWatchJobData>(fplPriceWatchQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export async function closeFplPriceWatchQueue(): Promise<void> {
  await fplPriceWatchQueue.close();
}
