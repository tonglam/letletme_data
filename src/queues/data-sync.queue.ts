import type { MutationPriorityTier } from '../domain/job-priority';
import { closeTieredQueues, createTieredQueueSet } from './tiered-queue';

export const dataSyncQueueName = 'data-sync';

export type DataSyncJobName =
  | 'core-snapshot'
  | 'events'
  | 'fixtures'
  | 'fixtures-all-gameweeks'
  | 'teams'
  | 'players'
  | 'player-prices'
  | 'player-stats'
  | 'phases'
  | 'player-values'
  | 'fpl-season-archive';

export interface DataSyncJobData {
  source?: 'cron' | 'manual' | 'api' | 'event-transition' | 'cascade';
  triggeredAt: string;
  /** Correlates one logical execution across BullMQ retries; independent of queue dedupe ID. */
  runId?: string;
  /** Optional event filter (fixtures, player-stats); absent = current/all behavior */
  eventId?: number;
  /** Price-history date in the configured cron timezone (YYYYMMDD). */
  changeDate?: string;
  /** Canonical four-digit season for archive jobs (for example 2627). */
  season?: string;
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
