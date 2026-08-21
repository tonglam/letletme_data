import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { tournamentSetupQueueName } from './names';

export { tournamentSetupQueueName } from './names';

export const TOURNAMENT_SETUP_MAX_ATTEMPTS = 3;
export const TOURNAMENT_SETUP_BACKOFF_DELAY_MS = 60_000;

export function getTournamentSetupRetryDelayMs(attempt: number): number {
  return TOURNAMENT_SETUP_BACKOFF_DELAY_MS * 2 ** Math.max(0, Math.trunc(attempt) - 1);
}

export interface TournamentSetupJobData {
  seasonId: number;
  seasonCode: string;
  tournamentId: number;
  source: 'create' | 'manual' | 'watchdog' | 'roster' | 'resume';
  triggeredAt: string;
  /** Activation marker owned by a resume-triggered setup job. */
  resumeMarker?: string;
}

export const tournamentSetupQueue = new Queue<TournamentSetupJobData>(tournamentSetupQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: TOURNAMENT_SETUP_MAX_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: TOURNAMENT_SETUP_BACKOFF_DELAY_MS,
    },
    removeOnComplete: {
      age: 86400,
      count: 100,
    },
    removeOnFail: {
      age: 172800,
      count: 50,
    },
  },
});

export async function closeTournamentSetupQueue() {
  await tournamentSetupQueue.close();
}
