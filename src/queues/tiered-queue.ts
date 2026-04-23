import { Queue, type JobsOptions } from 'bullmq';

import type { MutationPriorityTier } from '../domain/job-priority';
import { MUTATION_PRIORITY_ORDER } from '../domain/job-priority';
import { getQueueConnection } from '../utils/queue';

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function isTieredMutationQueueEnabled(): boolean {
  return parseBoolean(process.env.ENABLE_TIERED_MUTATION_QUEUES, false);
}

type TieredQueueSet<T> = {
  enabled: boolean;
  queuesByTier: Record<MutationPriorityTier, Queue<T>>;
  queueNamesByTier: Record<MutationPriorityTier, string>;
  uniqueQueues: Queue<T>[];
};

export function createTieredQueueSet<T>(
  baseQueueName: string,
  defaultJobOptions?: JobsOptions,
): TieredQueueSet<T> {
  const enabled = isTieredMutationQueueEnabled();
  if (!enabled) {
    const baseQueue = new Queue<T>(baseQueueName, {
      connection: getQueueConnection(),
      defaultJobOptions,
    });
    const queuesByTier = Object.fromEntries(
      MUTATION_PRIORITY_ORDER.map((tier) => [tier, baseQueue]),
    ) as Record<MutationPriorityTier, Queue<T>>;
    const queueNamesByTier = Object.fromEntries(
      MUTATION_PRIORITY_ORDER.map((tier) => [tier, baseQueueName]),
    ) as Record<MutationPriorityTier, string>;
    return { enabled, queuesByTier, queueNamesByTier, uniqueQueues: [baseQueue] };
  }

  const queuesByTier = {} as Record<MutationPriorityTier, Queue<T>>;
  const queueNamesByTier = {} as Record<MutationPriorityTier, string>;
  for (const tier of MUTATION_PRIORITY_ORDER) {
    const queueName = `${baseQueueName}-${tier}`;
    queueNamesByTier[tier] = queueName;
    queuesByTier[tier] = new Queue<T>(queueName, {
      connection: getQueueConnection(),
      defaultJobOptions,
    });
  }

  return {
    enabled,
    queuesByTier,
    queueNamesByTier,
    uniqueQueues: MUTATION_PRIORITY_ORDER.map((tier) => queuesByTier[tier]),
  };
}

export async function closeTieredQueues<T>(queues: Queue<T>[]) {
  await Promise.all(queues.map((queue) => queue.close()));
}
