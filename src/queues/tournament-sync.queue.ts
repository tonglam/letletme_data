import { Queue } from 'bullmq';

import type { TournamentFinalizationTarget } from '../domain/tournament';
import { getQueueConnection } from '../utils/queue';
import { tournamentSyncQueueName } from './names';

export { tournamentSyncQueueName } from './names';

export const TOURNAMENT_JOBS = {
  // Base job (triggers cascade)
  EVENT_RESULTS: 'tournament-event-results',
  // Cascade jobs (run after base completes)
  POINTS_RACE: 'tournament-points-race',
  BATTLE_RACE: 'tournament-battle-race',
  KNOCKOUT: 'tournament-knockout',
  TRANSFERS_POST: 'tournament-transfers-post',
  CUP_RESULTS: 'tournament-cup-results',
  SELECTION_STATS: 'tournament-selection-stats',
  // Materialized view refresh (runs after cascade jobs finish)
  MATERIALIZED_VIEWS_REFRESH: 'tournament-materialized-views-refresh',
  // Independent jobs (separate timing)
  EVENT_PICKS: 'tournament-event-picks',
  TRANSFERS_PRE: 'tournament-transfers-pre',
  // Info job (keep separate, low frequency)
  INFO: 'tournament-info',
  ROSTER_SYNC: 'tournament-roster-sync',
  ROSTER_RECONCILE: 'tournament-roster-reconcile',
  OFFICIAL_H2H: 'tournament-official-h2h',
} as const;

export type TournamentSyncJobName = (typeof TOURNAMENT_JOBS)[keyof typeof TOURNAMENT_JOBS];

export interface TournamentSyncJobData {
  seasonId: number;
  seasonCode: string;
  eventId: number;
  source: 'cron' | 'manual' | 'cascade';
  triggeredAt: string;
  /** Stable database-clock reuse cutoff retained across BullMQ attempts. */
  freshAfter?: string;
  /**
   * Shared id for one cascade fan-out. Structure and enrichment jobs that
   * finish under this id claim Redis barrier slots; the last one enqueues the
   * materialized-views refresh and terminal lifecycle publication.
   */
  cascadeId?: string;
  /** Exact standings publications selected by the base event-results job. */
  finalizationTargets?: TournamentFinalizationTarget[];
  tournamentId?: number;
  resumeAfterSetup?: boolean;
  /** Reconcile inactive tournaments only for explicit resume/retry callers. */
  allowInactive?: boolean;
}

export const tournamentSyncQueue = new Queue<TournamentSyncJobData>(tournamentSyncQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
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
  },
});

export async function closeTournamentSyncQueue() {
  await tournamentSyncQueue.close();
}
