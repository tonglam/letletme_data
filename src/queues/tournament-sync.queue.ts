import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';

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
