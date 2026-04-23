import type { MutationPriorityTier } from '../domain/job-priority';
import { closeTieredQueues, createTieredQueueSet } from './tiered-queue';

export const tournamentSyncQueueName = 'tournament-sync';

export const TOURNAMENT_JOBS = {
  // Base job (triggers cascade)
  EVENT_RESULTS: 'tournament-event-results',
  // Cascade jobs (run after base completes)
  POINTS_RACE: 'tournament-points-race',
  BATTLE_RACE: 'tournament-battle-race',
  KNOCKOUT: 'tournament-knockout',
  TRANSFERS_POST: 'tournament-transfers-post',
  CUP_RESULTS: 'tournament-cup-results',
  // Materialized view refresh (runs after cascade jobs finish)
  MATERIALIZED_VIEWS_REFRESH: 'tournament-materialized-views-refresh',
  // Independent jobs (separate timing)
  EVENT_PICKS: 'tournament-event-picks',
  TRANSFERS_PRE: 'tournament-transfers-pre',
  // Info job (keep separate, low frequency)
  INFO: 'tournament-info',
} as const;

export type TournamentSyncJobName = (typeof TOURNAMENT_JOBS)[keyof typeof TOURNAMENT_JOBS];

export interface TournamentSyncJobData {
  eventId: number;
  source: 'cron' | 'manual' | 'cascade';
  triggeredAt: string;
}

const tieredQueueSet = createTieredQueueSet<TournamentSyncJobData>(tournamentSyncQueueName, {
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

export const isTournamentSyncTieredQueueEnabled = tieredQueueSet.enabled;
export const tournamentSyncQueuesByTier = tieredQueueSet.queuesByTier;
export const tournamentSyncQueueNamesByTier = tieredQueueSet.queueNamesByTier;
export const tournamentSyncQueue = tournamentSyncQueuesByTier.p2;

export function getTournamentSyncQueue(tier: MutationPriorityTier) {
  return tournamentSyncQueuesByTier[tier];
}

export function getTournamentSyncQueueName(tier: MutationPriorityTier) {
  return tournamentSyncQueueNamesByTier[tier];
}

export async function closeTournamentSyncQueue() {
  await closeTieredQueues(tieredQueueSet.uniqueQueues);
}
