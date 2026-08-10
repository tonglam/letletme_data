import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { dataSyncQueueName } from './names';

export { dataSyncQueueName } from './names';

export type DataSyncJobName = 'core-snapshot' | 'player-prices' | 'player-stats' | 'player-values';

export interface DataSyncJobData {
  seasonId: number;
  seasonCode: string;
  source?: 'cron' | 'manual' | 'api' | 'event-transition' | 'cascade';
  triggeredAt: string;
  /** Correlates one logical execution across BullMQ retries; independent of queue dedupe ID. */
  runId?: string;
  /** Optional event filter (fixtures, player-stats); absent = current/all behavior */
  eventId?: number;
  /** Price-history date in the configured cron timezone (YYYYMMDD). */
  changeDate?: string;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 60_000,
  },
  removeOnComplete: 100,
  removeOnFail: 200,
};

export const dataSyncQueue = new Queue<DataSyncJobData>(dataSyncQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions,
});

export async function closeDataSyncQueue() {
  await dataSyncQueue.close();
}
