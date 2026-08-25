import { UnrecoverableError } from 'bullmq';

import { startSchedulerObligation } from '../repositories/scheduler-obligations';
import { logError, logInfo } from './logger';

type SchedulerObligationJobData = Readonly<{
  obligationId?: string;
  obligationGeneration?: number;
}>;

type SchedulerObligationJobContext = Readonly<{
  queueName: string;
  jobName: string;
  jobId?: string | number;
}>;

export type SchedulerObligationFence =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'complete'; obligationId: string; generation: number }>
  | Readonly<{ kind: 'malformed'; reason: string }>;

/**
 * Inspect untrusted Bull job data without weakening the generation guard.
 * Manual jobs carry neither value; scheduled jobs must carry two valid values.
 */
export function inspectSchedulerObligationFence(
  data: SchedulerObligationJobData,
): SchedulerObligationFence {
  const hasObligationValue = data.obligationId !== undefined;
  const hasGenerationValue = data.obligationGeneration !== undefined;
  if (!hasObligationValue && !hasGenerationValue) return { kind: 'none' };

  if (typeof data.obligationId !== 'string' || data.obligationId.length === 0) {
    return { kind: 'malformed', reason: 'obligationId must be a non-empty string' };
  }
  const generation = data.obligationGeneration;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
    return {
      kind: 'malformed',
      reason: 'obligationGeneration must be a non-negative safe integer',
    };
  }
  return {
    kind: 'complete',
    obligationId: data.obligationId,
    generation,
  };
}

/**
 * Manual jobs do not carry an obligation fence. Scheduled jobs must carry
 * both fields, and may run only while their exact generation is authoritative.
 */
export async function startCurrentSchedulerJob(
  data: SchedulerObligationJobData,
  context: SchedulerObligationJobContext,
): Promise<boolean> {
  const fence = inspectSchedulerObligationFence(data);
  if (fence.kind === 'none') return true;

  if (fence.kind === 'malformed') {
    const error = new UnrecoverableError(`Incomplete scheduler generation fence: ${fence.reason}`);
    logError('Rejecting scheduled job with an incomplete generation fence', error, {
      ...context,
      obligationId: data.obligationId,
      obligationGeneration: data.obligationGeneration,
    });
    throw error;
  }

  const started = await startSchedulerObligation({
    obligationId: fence.obligationId,
    generation: fence.generation,
  });
  if (!started) {
    logInfo('Skipping stale scheduler generation before job execution', {
      ...context,
      obligationId: fence.obligationId,
      obligationGeneration: fence.generation,
    });
  }
  return started;
}
