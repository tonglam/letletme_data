import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';

export const dataSyncQueueName = 'data-sync';

export type DataSyncJobName = 'events' | 'teams' | 'players' | 'phases';

export interface DataSyncJobData {
  source?: 'cron' | 'manual' | 'api';
  triggeredAt: string;
}

export const dataSyncQueue = new Queue<DataSyncJobData>(dataSyncQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export async function closeDataSyncQueue() {
  await dataSyncQueue.close();
}
