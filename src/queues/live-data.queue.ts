import type { MutationPriorityTier } from '../domain/job-priority';
import { closeTieredQueues, createTieredQueueSet } from './tiered-queue';

export const liveDataQueueName = 'live-data';

export const LIVE_JOBS = {
  EVENT_LIVES_CACHE: 'event-lives-cache',
  EVENT_LIVES_DB: 'event-lives-db',
  EVENT_LIVE_SUMMARY: 'event-live-summary',
  EVENT_LIVE_EXPLAIN: 'event-live-explain',
  LIVE_FIXTURE_CACHE: 'live-fixture-cache',
  LIVE_BONUS_CACHE: 'live-bonus-cache',
  EVENT_OVERALL_RESULT: 'event-overall-result',
  LIVE_SCORES: 'live-scores',
} as const;

export type LiveDataJobName = (typeof LIVE_JOBS)[keyof typeof LIVE_JOBS];

export interface LiveDataJobData {
  eventId: number;
  source: 'cron' | 'manual' | 'cascade';
  triggeredAt: string;
  /** Post-match consolidation runs outside the live window; skips the worker re-check */
  skipWindowCheck?: boolean;
}

const tieredQueueSet = createTieredQueueSet<LiveDataJobData>(liveDataQueueName, {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 60_000, // 1 minute
  },
  removeOnComplete: {
    age: 86400, // 24 hours
    count: 100,
  },
  removeOnFail: {
    age: 172800, // 48 hours
    count: 50,
  },
});

export const isLiveDataTieredQueueEnabled = tieredQueueSet.enabled;
export const liveDataQueuesByTier = tieredQueueSet.queuesByTier;
export const liveDataQueueNamesByTier = tieredQueueSet.queueNamesByTier;
export const liveDataQueue = liveDataQueuesByTier.p3;

export function getLiveDataQueue(tier: MutationPriorityTier) {
  return liveDataQueuesByTier[tier];
}

export function getLiveDataQueueName(tier: MutationPriorityTier) {
  return liveDataQueueNamesByTier[tier];
}

export async function closeLiveDataQueue() {
  await closeTieredQueues(tieredQueueSet.uniqueQueues);
}
