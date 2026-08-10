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
  seasonId: number;
  seasonCode: string;
  source?: EntrySyncJobSource;
  triggeredAt: string;
  entryIds?: number[];
  retryCount?: number;
  afterEntryId?: number;
  /** Continue the table scan here only after an exact failed-ID retry succeeds. */
  resumeAfterEntryId?: number;
  chunkSize?: number;
  concurrency?: number;
  throttleMs?: number;
  eventId?: number;
  runId?: string;
  queueKey?: string;
  /** Propagated through continuation/retry chunks for deterministic daily jobs. */
  removeOnSettle?: boolean;
}

export const entrySyncQueue = new Queue<EntrySyncJobData>(entrySyncQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60_000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export async function closeEntrySyncQueue() {
  await entrySyncQueue.close();
}
