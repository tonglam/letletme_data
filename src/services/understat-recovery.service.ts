import { UnrecoverableError } from 'bullmq';

import { UnderstatClientError } from '../clients/understat';
import { getUnderstatPlayerQueue } from '../queues/understat-player.queue';
import { getUnderstatTeamQueue } from '../queues/understat-team.queue';
import { understatSyncRepository } from '../repositories/understat-sync';
import {
  failSchedulerObligation,
  markSchedulerObligationIrrecoverable,
} from '../repositories/scheduler-obligations';
import { logInfo, logWarn } from '../utils/logger';
import { notifyTwoBots } from '../utils/notify';

export const UNDERSTAT_MAX_SCHEDULER_GENERATIONS = 3;
export const UNDERSTAT_COMPLETENESS_RETRY_DELAY_MS = 30 * 60_000;
export const UNDERSTAT_ORPHAN_CUTOFF_MS = 30 * 60_000;

export function understatObligationFailureDisposition(
  generation: number | undefined,
  nonRetryable: boolean,
): 'retry' | 'terminal' {
  return nonRetryable ||
    (generation !== undefined && generation + 1 >= UNDERSTAT_MAX_SCHEDULER_GENERATIONS)
    ? 'terminal'
    : 'retry';
}

function numericGeneration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function metadataObligation(metadata: Record<string, unknown>): {
  obligationId?: string;
  generation?: number;
} {
  return {
    ...(typeof metadata.obligationId === 'string' ? { obligationId: metadata.obligationId } : {}),
    ...(numericGeneration(metadata.obligationGeneration) === undefined
      ? {}
      : { generation: numericGeneration(metadata.obligationGeneration) }),
  };
}

export function isUnderstatNonRetryableError(error: unknown): boolean {
  return (
    error instanceof UnrecoverableError ||
    (error instanceof Error && error.name === 'UnrecoverableError') ||
    (error instanceof UnderstatClientError && !error.retryable) ||
    (error instanceof Error && error.name === 'UnderstatSchemaError')
  );
}

export async function settleUnderstatObligationFailure(input: {
  obligationId?: string;
  generation?: number;
  error: unknown;
  nonRetryable?: boolean;
  retryDelayMs?: number;
}): Promise<'none' | 'retrying' | 'terminal' | 'stale'> {
  if (!input.obligationId) return 'none';
  const generation = input.generation;
  const nonRetryable = input.nonRetryable ?? isUnderstatNonRetryableError(input.error);
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  if (understatObligationFailureDisposition(generation, nonRetryable) === 'terminal') {
    const closed = await markSchedulerObligationIrrecoverable({
      obligationId: input.obligationId,
      ...(generation === undefined ? {} : { generation }),
      status: 'skipped',
      includeInFlight: true,
      evidence: {
        provider: 'understat',
        terminal: true,
        reason: nonRetryable ? 'non-retryable' : 'generation-limit',
        error: message,
      },
    });
    return closed ? 'terminal' : 'stale';
  }
  const retried = await failSchedulerObligation({
    obligationId: input.obligationId,
    ...(generation === undefined ? {} : { generation }),
    error: input.error,
    retryDelayMs: input.retryDelayMs,
  });
  return retried ? 'retrying' : 'stale';
}

export async function settleUnderstatCompleteness(input: {
  obligationId?: string;
  generation?: number;
  reason: string;
}): Promise<'none' | 'retrying' | 'terminal' | 'stale'> {
  if (!input.obligationId) return 'none';
  const exhausted =
    input.generation !== undefined && input.generation + 1 >= UNDERSTAT_MAX_SCHEDULER_GENERATIONS;
  if (exhausted) {
    const closed = await markSchedulerObligationIrrecoverable({
      obligationId: input.obligationId,
      generation: input.generation,
      status: 'skipped',
      includeInFlight: true,
      evidence: {
        provider: 'understat',
        terminal: true,
        reason: 'completeness-generation-limit',
        completeness: input.reason,
      },
    });
    return closed ? 'terminal' : 'stale';
  }
  const retried = await failSchedulerObligation({
    obligationId: input.obligationId,
    ...(input.generation === undefined ? {} : { generation: input.generation }),
    error: new Error(`Understat snapshot incomplete: ${input.reason}`),
    retryDelayMs: UNDERSTAT_COMPLETENESS_RETRY_DELAY_MS,
  });
  return retried ? 'retrying' : 'stale';
}

async function understatQueueHasWork(): Promise<boolean> {
  const [teamCounts, playerCounts] = await Promise.all([
    getUnderstatTeamQueue().getJobCounts('waiting', 'delayed', 'active', 'paused'),
    getUnderstatPlayerQueue().getJobCounts('waiting', 'delayed', 'active', 'paused'),
  ]);
  return [teamCounts, playerCounts].some((counts) =>
    Object.values(counts).some((count) => count > 0),
  );
}

export interface UnderstatOrphanReconciliationResult {
  candidates: number;
  recovered: number;
  skippedBecauseQueueBusy: boolean;
}

export async function reconcileUnderstatOrphanedRuns(
  now = new Date(),
): Promise<UnderstatOrphanReconciliationResult> {
  const cutoff = new Date(now.getTime() - UNDERSTAT_ORPHAN_CUTOFF_MS);
  const candidates = await understatSyncRepository.findOrphanedRuns(cutoff);
  if (candidates.length === 0) {
    return { candidates: 0, recovered: 0, skippedBecauseQueueBusy: false };
  }
  if (await understatQueueHasWork()) {
    logInfo('Understat orphan recovery deferred while queues still have work', {
      candidates: candidates.length,
    });
    return { candidates: candidates.length, recovered: 0, skippedBecauseQueueBusy: true };
  }

  let recovered = 0;
  for (const candidate of candidates) {
    const error = `Understat ${candidate.lane} run ${candidate.runId} made no database progress for 30 minutes`;
    const settled = await understatSyncRepository.markOrphanedRun({
      runId: candidate.runId,
      error,
      recoveredAt: now,
    });
    if (!settled) continue;
    recovered += 1;
    const obligation = metadataObligation(candidate.metadata);
    if (obligation.obligationId) {
      await settleUnderstatObligationFailure({
        obligationId: obligation.obligationId,
        generation: obligation.generation,
        error,
      });
    } else {
      await notifyTwoBots(
        `⚠️ Understat orphan run recovered\nLane: ${candidate.lane}\nSeason: ${candidate.season}\nRun: ${candidate.runId}\nError: ${error}`,
        { idempotencyKey: `understat-orphan:${candidate.runId}` },
      );
    }
    logWarn('Understat orphan run marked failed', {
      runId: candidate.runId,
      lane: candidate.lane,
      season: candidate.season,
      obligationId: obligation.obligationId,
      generation: obligation.generation,
    });
  }
  return { candidates: candidates.length, recovered, skippedBecauseQueueBusy: false };
}
