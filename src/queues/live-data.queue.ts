import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { liveDataQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';
import type { MatchLifecycleState } from '../services/live-match-v2';

export { liveDataQueueName } from './names';

export const LIVE_JOBS = {
  LIVE_SNAPSHOT: 'live-snapshot',
  LIVE_MATCH_CHECKPOINT: 'live-match-checkpoint',
} as const;

export type LiveDataJobName = (typeof LIVE_JOBS)[keyof typeof LIVE_JOBS];

export interface LiveDataJobData {
  seasonId: number;
  seasonCode: string;
  eventId: number;
  source: 'cron' | 'manual' | 'cascade' | 'catchup' | 'reconcile';
  triggeredAt: string;
  runId?: string;
  /** Durable scheduler obligation identity carried through worker completion. */
  obligationId?: string;
  obligationGeneration?: number;
  /** Exact freshness window being repaired, carried into the publication manifest. */
  freshnessWindowId?: number;
  /** Only the post-match consolidation may publish terminal live authority. */
  finalizeEvent?: boolean;
  /** Lifecycle state captured by the scheduler for the sibling Match desk. */
  lifecycleState?: MatchLifecycleState;
  /** A checkpoint-only job never calls FPL; it consumes Redis publication data. */
  checkpointKind?: 'desk' | 'detail';
  checkpointPublicationId?: string;
  checkpointGeneration?: number;
}

export const liveDataQueue = new Queue<LiveDataJobData>(liveDataQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60_000, // 1 minute
    },
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export async function closeLiveDataQueue() {
  await liveDataQueue.close();
}
