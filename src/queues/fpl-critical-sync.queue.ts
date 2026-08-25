import { Queue } from 'bullmq';

import type { DataSyncJobData } from './data-sync.queue';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';
import { getQueueConnection } from '../utils/queue';

export const fplCriticalSyncQueueName = 'fpl-critical-sync';

export type FplCriticalJobName = 'price-change-predictions' | 'core-snapshot-price-change-repair';

export interface FplCriticalJobData extends DataSyncJobData {
  laneId: string;
  laneGeneration: number;
  blockerLaneId?: string;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 60_000,
  },
  removeOnComplete: BULL_COMPLETED_RETENTION,
  removeOnFail: BULL_FAILED_RETENTION,
};

export const fplCriticalSyncQueue = new Queue<FplCriticalJobData>(fplCriticalSyncQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions,
});

export async function closeFplCriticalSyncQueue(): Promise<void> {
  await fplCriticalSyncQueue.close();
}
