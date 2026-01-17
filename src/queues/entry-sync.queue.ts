import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';

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
