import type { MutationPriorityTier } from '../domain/job-priority';
import { closeTieredQueues, createTieredQueueSet } from './tiered-queue';

export const tournamentSetupQueueName = 'tournament-setup';

export interface TournamentSetupJobData {
  tournamentId: number;
  source: 'create' | 'manual' | 'watchdog';
  triggeredAt: string;
}

const tieredQueueSet = createTieredQueueSet<TournamentSetupJobData>(tournamentSetupQueueName, {
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
});

export const isTournamentSetupTieredQueueEnabled = tieredQueueSet.enabled;
export const tournamentSetupQueuesByTier = tieredQueueSet.queuesByTier;
export const tournamentSetupQueueNamesByTier = tieredQueueSet.queueNamesByTier;
export const tournamentSetupQueue = tournamentSetupQueuesByTier.p0;

export function getTournamentSetupQueue(tier: MutationPriorityTier) {
  return tournamentSetupQueuesByTier[tier];
}

export function getTournamentSetupQueueName(tier: MutationPriorityTier) {
  return tournamentSetupQueueNamesByTier[tier];
}

export async function closeTournamentSetupQueue() {
  await closeTieredQueues(tieredQueueSet.uniqueQueues);
}
