import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';

export const entrySyncQueueName = 'entry-sync';

export type EntrySyncJobName = 'entry-info' | 'entry-picks' | 'entry-transfers' | 'entry-results';

export interface EntrySyncJobData {
  source?: 'cron' | 'manual' | 'api';
  triggeredAt: string;
  entryIds?: number[];
  retryCount?: number;
}

export const entrySyncQueue = new Queue<EntrySyncJobData>(entrySyncQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export async function closeEntrySyncQueue() {
  await entrySyncQueue.close();
}
