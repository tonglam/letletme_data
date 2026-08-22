import { Queue } from 'bullmq';

import type { TournamentFinalizationTarget } from '../domain/tournament';
import { getQueueConnection } from '../utils/queue';
import { tournamentSyncQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

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
  source: 'cron' | 'manual' | 'cascade' | 'watchdog' | 'catchup' | 'reconcile';
  triggeredAt: string;
  runId?: string;
  /** Durable scheduler obligation identity carried through the root job. */
  obligationId?: string;
  obligationGeneration?: number;
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
  /** Database-clock marker written by the activation request. */
  resumeMarker?: string;
  /** Reconcile inactive tournaments only for explicit resume/retry callers. */
  allowInactive?: boolean;
  /** Settle a queued opt-in when the gameweek boundary closes before it runs. */
  settleBoundaryFailure?: boolean;
  /** Repair an additive official-H2H roster only while its schedule is still unlocked. */
  allowUnlockedOfficialH2HRecovery?: boolean;
  /** Progress marker observed when a non-resume retry was queued. */
  expectedProgressMarker?: string | null;
}

export const tournamentSyncQueue = new Queue<TournamentSyncJobData>(tournamentSyncQueueName, {
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

export async function closeTournamentSyncQueue() {
  await tournamentSyncQueue.close();
}
