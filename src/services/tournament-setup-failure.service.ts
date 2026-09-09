import type { Job } from 'bullmq';

import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import { getTournamentSetupRetryDelayMs } from '../domain/tournament-setup-retry';
import { requireCurrentSeasonForJob } from './season-scoped-job.service';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { TournamentSetupJobData } from '../queues/tournament-setup.queue';
import {
  tournamentInfoRepository,
  type TournamentSetupAttemptFailure,
  type TournamentSetupExecution,
  type TournamentSetupStatusRow,
} from '../repositories/tournament-infos';
import { withMutationScopes } from '../utils/mutation-scopes';
import { isTerminalJobFailure } from '../utils/worker-failure';

export type FailedTournamentSetupJob = Pick<
  Job<TournamentSetupJobData>,
  'id' | 'name' | 'queueName' | 'data' | 'attemptsMade' | 'opts' | 'processedOn'
>;

export interface EscapedSetupFailureDependencies {
  requireSeason: (data: TournamentSetupJobData) => Promise<FplSeasonRef>;
  findStatus: (
    season: FplSeasonRef,
    tournamentId: number,
  ) => Promise<TournamentSetupStatusRow | null>;
  persistFailure: (
    season: FplSeasonRef,
    job: FailedTournamentSetupJob,
    failure: TournamentSetupAttemptFailure,
  ) => Promise<boolean>;
  now: () => Date;
}

const defaultDependencies: EscapedSetupFailureDependencies = {
  requireSeason: requireCurrentSeasonForJob,
  findStatus: (season, tournamentId) =>
    tournamentInfoRepository.findSetupStatus(season, tournamentId),
  persistFailure: (season, job, failure) =>
    withMutationScopes(
      {
        queueName: job.queueName,
        jobName: `${job.name}-failure-fallback`,
        jobId: String(job.id),
        tournamentId: job.data.tournamentId,
        scopes: [tournamentSetupLifecycleScope(job.data.tournamentId)],
      },
      () =>
        tournamentInfoRepository.markSetupAttemptFailure(season, job.data.tournamentId, failure),
    ),
  now: () => new Date(),
};

export function tournamentSetupErrorCode(error: unknown): string {
  const seen = new Set<unknown>();
  let fallback: string | null = null;
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') {
      fallback ??= current.code;
      if (/^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    }
    current = 'cause' in current ? current.cause : null;
  }
  return fallback ?? (error instanceof Error ? error.name : 'SETUP_FAILED');
}

/**
 * Persist a failed BullMQ attempt in a fresh lifecycle transaction. This is the
 * fallback for errors that escape the processor's short claim/failure phases.
 * A claimed execution keeps its identity so this cannot consume a successor's retry.
 */
export async function persistEscapedTournamentSetupFailure(
  job: FailedTournamentSetupJob,
  error: unknown,
  dependencies: EscapedSetupFailureDependencies = defaultDependencies,
  execution?: TournamentSetupExecution,
): Promise<boolean> {
  // A failed-event listener cannot reconstruct ownership by reading current
  // state: it may already belong to a successor. Unclaimed failures are handled
  // by the processor using its pre-claim snapshot, or by watchdog recovery.
  if (!execution) return false;
  const season = await dependencies.requireSeason(job.data);
  const status = await dependencies.findStatus(season, job.data.tournamentId);
  if (
    !status ||
    status.setupStatus === 'ready' ||
    (status.setupStatus === 'failed' && !status.setupNextRetryAt)
  ) {
    return false;
  }

  const maxAttempts = Math.max(1, status.setupMaxAttempts ?? job.opts.attempts ?? 1);
  const nextAttempt = execution.attempt;
  const attempt = Math.min(maxAttempts, nextAttempt);
  const terminal = isTerminalJobFailure(job, error) || nextAttempt >= maxAttempts;
  const now = dependencies.now();
  const processedOn = job.processedOn;
  const startedAt =
    typeof processedOn === 'number' && Number.isFinite(processedOn) ? new Date(processedOn) : now;

  return dependencies.persistFailure(season, job, {
    execution,
    attempt,
    terminal,
    errorCode: tournamentSetupErrorCode(error),
    nextRetryAt: terminal
      ? null
      : new Date(now.getTime() + getTournamentSetupRetryDelayMs(attempt)),
    startedAt,
  });
}
