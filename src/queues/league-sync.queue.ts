import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';

export const leagueSyncQueueName = 'league-sync';

export const LEAGUE_JOBS = {
  LEAGUE_EVENT_PICKS: 'league-event-picks',
  LEAGUE_EVENT_RESULTS: 'league-event-results',
} as const;

export type LeagueSyncJobName = (typeof LEAGUE_JOBS)[keyof typeof LEAGUE_JOBS];

export interface LeagueSyncJobData {
  eventId: number;
  tournamentId?: number; // If specified, process only this tournament; if not, coordinator job
  source: 'cron' | 'manual' | 'cascade';
  triggeredAt: string;
}

export const leagueSyncQueue = new Queue<LeagueSyncJobData>(leagueSyncQueueName, {
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

export async function closeLeagueSyncQueue() {
  await leagueSyncQueue.close();
}
