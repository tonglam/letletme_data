import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { entrySyncQueueName } from './names';
import { livePicksQueue } from './live-picks.queue';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { entrySyncQueueName } from './names';

export type EntrySyncJobName = 'entry-info' | 'entry-picks' | 'entry-transfers' | 'entry-results';

export type EntrySyncJobSource = 'cron' | 'manual' | 'api' | 'catchup' | 'reconcile';
export type EntrySyncLane = 'entry-sync' | 'live-picks';

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
  /** The live-picks lane is an isolated Bull queue; old payloads default to entry-sync. */
  lane?: EntrySyncLane;
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
  /** Durable scheduler obligation carried through every scan chunk/retry. */
  obligationId?: string;
  obligationGeneration?: number;
  /** Stable source checkpoint retained across scan chunks and retries. */
  freshAfter?: string;
  queueKey?: string;
  /** Stable BullMQ single-flight identity for restart-sensitive fan-out jobs. */
  deduplicationId?: string;
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
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export { livePicksQueue } from './live-picks.queue';

export async function closeEntrySyncQueue() {
  await entrySyncQueue.close();
  await livePicksQueue.close();
}
