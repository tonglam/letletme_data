import type { MutationPriorityTier } from '../domain/job-priority';
import { closeTieredQueues, createTieredQueueSet } from './tiered-queue';

export const dataSyncQueueName = 'data-sync';

export type DataSyncJobName =
  | 'events'
  | 'fixtures'
  | 'fixtures-all-gameweeks'
  | 'teams'
  | 'players'
  | 'player-stats'
  | 'phases'
  | 'player-values';

export interface DataSyncJobData {
  source?: 'cron' | 'manual' | 'api' | 'event-transition';
  triggeredAt: string;
  /** Optional event filter (fixtures, player-stats); absent = current/all behavior */
  eventId?: number;
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

const tieredQueueSet = createTieredQueueSet<DataSyncJobData>(dataSyncQueueName, defaultJobOptions);

export const isDataSyncTieredQueueEnabled = tieredQueueSet.enabled;
export const dataSyncQueuesByTier = tieredQueueSet.queuesByTier;
export const dataSyncQueueNamesByTier = tieredQueueSet.queueNamesByTier;
export const dataSyncQueue = dataSyncQueuesByTier.p1;

export function getDataSyncQueue(tier: MutationPriorityTier) {
  return dataSyncQueuesByTier[tier];
}

export function getDataSyncQueueName(tier: MutationPriorityTier) {
  return dataSyncQueueNamesByTier[tier];
}

export async function closeDataSyncQueue() {
  await closeTieredQueues(tieredQueueSet.uniqueQueues);
}
