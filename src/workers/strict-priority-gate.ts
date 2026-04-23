import type { Queue, Worker } from 'bullmq';

import type { MutationPriorityTier } from '../domain/job-priority';
import { MUTATION_PRIORITY_ORDER } from '../domain/job-priority';
import { logError, logInfo } from '../utils/logger';

const DEFAULT_POLL_MS = 5_000;

type GateWorkerSet<T> = Record<MutationPriorityTier, { queue: Queue<T>; worker: Worker<T> }>;

async function getBacklogCount<T>(queue: Queue<T>): Promise<number> {
  const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
  return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
}

export function startStrictPriorityGate<T>(
  domain: string,
  workerSet: GateWorkerSet<T>,
  options?: { enabled?: boolean; pollMs?: number },
): { stop: () => void } {
  const enabled = options?.enabled ?? true;
  if (!enabled) {
    return { stop: () => undefined };
  }

  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  const pausedByTier = new Set<MutationPriorityTier>();

  const evaluate = async () => {
    const backlogs = {} as Record<MutationPriorityTier, number>;
    for (const tier of MUTATION_PRIORITY_ORDER) {
      backlogs[tier] = await getBacklogCount(workerSet[tier].queue);
    }

    for (let index = 1; index < MUTATION_PRIORITY_ORDER.length; index += 1) {
      const tier = MUTATION_PRIORITY_ORDER[index];
      const higherTiers = MUTATION_PRIORITY_ORDER.slice(0, index);
      const hasHigherBacklog = higherTiers.some((higherTier) => backlogs[higherTier] > 0);
      const worker = workerSet[tier].worker;

      if (hasHigherBacklog && !pausedByTier.has(tier)) {
        await worker.pause(true);
        pausedByTier.add(tier);
        logInfo('Tier worker paused by strict priority gate', {
          domain,
          tier,
          higherBacklog: higherTiers.reduce((sum, higherTier) => sum + backlogs[higherTier], 0),
          backlogs,
        });
      } else if (!hasHigherBacklog && pausedByTier.has(tier)) {
        await worker.resume();
        pausedByTier.delete(tier);
        logInfo('Tier worker resumed by strict priority gate', {
          domain,
          tier,
          backlogs,
        });
      }
    }
  };

  void evaluate().catch((error) => {
    logError('Strict priority gate initial evaluation failed', error, { domain });
  });

  timer = setInterval(() => {
    void evaluate().catch((error) => {
      logError('Strict priority gate evaluation failed', error, { domain });
    });
  }, pollMs);
  timer.unref?.();

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
