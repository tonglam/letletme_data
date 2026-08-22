import { Queue } from 'bullmq';

import {
  TOURNAMENT_SETUP_BACKOFF_DELAY_MS,
  TOURNAMENT_SETUP_MAX_ATTEMPTS,
} from '../domain/tournament-setup-retry';
import { getQueueConnection } from '../utils/queue';
import { tournamentSetupQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export { tournamentSetupQueueName } from './names';
export {
  getTournamentSetupRetryDelayMs,
  TOURNAMENT_SETUP_BACKOFF_DELAY_MS,
  TOURNAMENT_SETUP_MAX_ATTEMPTS,
} from '../domain/tournament-setup-retry';

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
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export async function closeTournamentSetupQueue() {
  await tournamentSetupQueue.close();
}
