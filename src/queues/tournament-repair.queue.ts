import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { tournamentRepairQueueName } from './names';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';

export interface TournamentRepairJobData {
  seasonId: number;
  seasonCode: string;
  tournamentId: number;
  issueId: number;
  triggeredAt: string;
  source: 'setup' | 'watchdog' | 'reconciliation';
}

export const tournamentRepairQueue = new Queue<TournamentRepairJobData>(tournamentRepairQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 300_000 },
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

export function tournamentRepairJobId(seasonCode: string, tournamentId: number, issueId: number) {
  return `tournament-repair-${seasonCode}-${tournamentId}-${issueId}`;
}

export async function closeTournamentRepairQueue() {
  await tournamentRepairQueue.close();
}
