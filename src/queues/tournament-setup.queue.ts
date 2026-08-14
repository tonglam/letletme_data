import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { tournamentSetupQueueName } from './names';

export { tournamentSetupQueueName } from './names';

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
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60_000,
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
