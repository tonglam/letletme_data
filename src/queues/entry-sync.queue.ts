import type { MutationPriorityTier } from '../domain/job-priority';
import { closeTieredQueues, createTieredQueueSet } from './tiered-queue';

export const entrySyncQueueName = 'entry-sync';

export type EntrySyncJobName = 'entry-info' | 'entry-picks' | 'entry-transfers' | 'entry-results';

export type EntrySyncJobSource = 'cron' | 'manual' | 'api';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export const ENTRY_SYNC_DEFAULT_CHUNK_SIZE = parsePositiveInt(
  process.env.ENTRY_SYNC_CHUNK_SIZE,
  500,
);

export const ENTRY_SYNC_DEFAULT_CONCURRENCY = parsePositiveInt(
  process.env.ENTRY_SYNC_CONCURRENCY,
  5,
);

export const ENTRY_SYNC_DEFAULT_THROTTLE_MS = parsePositiveInt(
  process.env.ENTRY_SYNC_THROTTLE_MS,
  200,
);

export interface EntrySyncJobData {
  source?: EntrySyncJobSource;
  triggeredAt: string;
  entryIds?: number[];
  retryCount?: number;
  chunkOffset?: number;
  chunkSize?: number;
  concurrency?: number;
  throttleMs?: number;
  eventId?: number;
  runId?: string;
}

const tieredQueueSet = createTieredQueueSet<EntrySyncJobData>(entrySyncQueueName, {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 60_000,
  },
  removeOnComplete: 100,
  removeOnFail: 200,
});

export const isEntrySyncTieredQueueEnabled = tieredQueueSet.enabled;
export const entrySyncQueuesByTier = tieredQueueSet.queuesByTier;
export const entrySyncQueueNamesByTier = tieredQueueSet.queueNamesByTier;
export const entrySyncQueue = entrySyncQueuesByTier.p2;

export function getEntrySyncQueue(tier: MutationPriorityTier) {
  return entrySyncQueuesByTier[tier];
}

export function getEntrySyncQueueName(tier: MutationPriorityTier) {
  return entrySyncQueueNamesByTier[tier];
}

export async function closeEntrySyncQueue() {
  await closeTieredQueues(tieredQueueSet.uniqueQueues);
}
