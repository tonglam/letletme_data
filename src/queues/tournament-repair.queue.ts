import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { tournamentRepairQueueName } from './names';

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
    removeOnComplete: { age: 86400, count: 200 },
    removeOnFail: { age: 172800, count: 100 },
  },
});

export function tournamentRepairJobId(seasonCode: string, tournamentId: number, issueId: number) {
  return `tournament-repair-${seasonCode}-${tournamentId}-${issueId}`;
}

export async function closeTournamentRepairQueue() {
  await tournamentRepairQueue.close();
}
