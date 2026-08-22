import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { leagueSyncQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { leagueSyncQueueName } from './names';

export const LEAGUE_JOBS = {
  LEAGUE_EVENT_PICKS: 'league-event-picks',
  LEAGUE_EVENT_RESULTS: 'league-event-results',
} as const;

export type LeagueSyncJobName = (typeof LEAGUE_JOBS)[keyof typeof LEAGUE_JOBS];

export interface LeagueSyncJobData {
  seasonId: number;
  seasonCode: string;
  eventId: number;
  tournamentId?: number; // If specified, process only this tournament; if not, coordinator job
  source: 'cron' | 'manual' | 'cascade' | 'catchup' | 'reconcile';
  triggeredAt: string;
  /** Stable database-clock reuse cutoff retained across BullMQ attempts. */
  freshAfter?: string;
  /** Correlates a coordinator and all of its per-tournament child attempts. */
  runId?: string;
  /** Durable scheduler obligation identity carried through coordinator jobs. */
  obligationId?: string;
  obligationGeneration?: number;
}

export const leagueSyncQueue = new Queue<LeagueSyncJobData>(leagueSyncQueueName, {
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

export async function closeLeagueSyncQueue() {
  await leagueSyncQueue.close();
}
