import {
  tournamentSetupQueue,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentSetupEnqueueScope } from '../domain/mutation-scope';
import { ConflictError } from '../utils/errors';
import { logError, logInfo, logWarn } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';

export type TournamentSetupJobSource = 'create' | 'manual' | 'watchdog' | 'roster' | 'resume';
export interface EnqueueTournamentSetupOptions {
  forceNew?: boolean;
  prepareEnqueue?: () => Promise<void>;
  /**
   * Queue a distinct successor when an active job remains ambiguous after the
   * settle window. Only lifecycle-locked callers may use this: the successor
   * waits behind the caller and guarantees that newly published state is read.
   */
  ensureSuccessorOnActive?: boolean;
  /**
   * Only callers already holding the tournament lifecycle lock may use this.
   * It bridges the short interval between a worker releasing that lock and
   * BullMQ recording the job as completed.
   */
  activeSettleTimeoutMs?: number;
  /** Database marker for a resume-triggered setup operation. */
  resumeMarker?: string;
}

export type ExistingSetupJobAction =
  | 'remove'
  | 'reuse'
  | 'reject'
  | 'enqueue_base'
  | 'enqueue_successor';

export function getTournamentSetupJobIds(
  season: FplSeasonRef,
  tournamentId: number,
  resumeMarker?: string,
): {
  baseJobId: string;
  successorJobId: string;
} {
  const markerSuffix = resumeMarker
    ? `-resume-${resumeMarker.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : '';
  const baseJobId = `tournament-setup-${season.seasonCode}-${tournamentId}${markerSuffix}`;
  return {
    baseJobId,
    successorJobId: `${baseJobId}-successor`,
  };
}

export function decideExistingSetupSuccessorAction(
  state: string,
  progress?: unknown,
  options: Pick<EnqueueTournamentSetupOptions, 'forceNew' | 'ensureSuccessorOnActive'> = {},
): 'remove' | 'reuse' | 'enqueue' | 'reject' {
  if (state === 'unknown') return 'enqueue';
  if (state === 'completed' || state === 'failed') return 'remove';
  if (state === 'active' && progress === 'settling') {
    if (options.ensureSuccessorOnActive) return 'enqueue';
    if (options.forceNew) return 'reject';
  }
  return 'reuse';
}

export function decideExistingSetupJobAction(
  state: string,
  options: Pick<
    EnqueueTournamentSetupOptions,
    'forceNew' | 'prepareEnqueue' | 'ensureSuccessorOnActive'
  >,
  progress?: unknown,
): ExistingSetupJobAction {
  if (state === 'unknown') return 'enqueue_base';
  if (state === 'completed' || state === 'failed') return 'remove';
  if (!options.forceNew) return 'reuse';
  if (state === 'waiting' || state === 'delayed') return 'remove';
  if (state === 'active' && options.ensureSuccessorOnActive) {
    return progress === 'waiting_for_lifecycle' ? 'reuse' : 'enqueue_successor';
  }
  return 'reject';
}

async function waitForActiveJobToSettle(
  job: { getState(): Promise<string> },
  timeoutMs: number,
): Promise<string> {
  let state = await job.getState();
  if (state !== 'active' || timeoutMs <= 0) return state;

  const deadline = performance.now() + timeoutMs;
  while (state === 'active' && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    state = await job.getState();
  }
  return state;
}

export async function cancelWaitingTournamentSetupJobs(tournamentId: number): Promise<number> {
  let removed = 0;
  const jobs = await tournamentSetupQueue.getJobs(['waiting', 'delayed', 'paused']);
  for (const job of jobs) {
    if (job.data.tournamentId !== tournamentId) continue;
    try {
      await job.remove();
      removed += 1;
    } catch (error) {
      logWarn('Unable to remove waiting tournament setup job', {
        tournamentId,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removed;
}

async function enqueueTournamentSetupUnlocked(
  season: FplSeasonRef,
  tournamentId: number,
  source: TournamentSetupJobSource = 'create',
  options: EnqueueTournamentSetupOptions = {},
) {
  try {
    const queue = tournamentSetupQueue;
    const jobData: TournamentSetupJobData = {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      tournamentId,
      source,
      triggeredAt: new Date().toISOString(),
      ...(options.resumeMarker ? { resumeMarker: options.resumeMarker } : {}),
    };

    const { baseJobId, successorJobId } = getTournamentSetupJobIds(
      season,
      tournamentId,
      options.resumeMarker,
    );
    // A lifecycle-locked caller can leave one durable successor behind an
    // active base job. Always inspect that stable slot first: otherwise later
    // reconciliations only see the base ID and can queue duplicate rebuilds.
    let successorSlotUnavailable = false;
    const existingSuccessor = await queue.getJob(successorJobId);
    if (existingSuccessor) {
      const successorState = await existingSuccessor.getState();
      const successorAction = decideExistingSetupSuccessorAction(
        successorState,
        existingSuccessor.progress,
        options,
      );
      if (successorAction === 'remove') {
        await existingSuccessor.remove();
      } else if (successorAction === 'reuse') {
        logInfo('Tournament setup successor already pending; reusing existing', {
          tournamentId,
          jobId: successorJobId,
          state: successorState,
          source,
        });
        return existingSuccessor;
      } else if (successorAction === 'reject') {
        throw new ConflictError(
          'Tournament setup is already settling.',
          'TOURNAMENT_SETUP_IN_PROGRESS',
        );
      } else {
        successorSlotUnavailable = successorState === 'active';
      }
    }

    const existing = await queue.getJob(baseJobId);
    let jobId: string | undefined = baseJobId;
    if (existing) {
      const state = await waitForActiveJobToSettle(existing, options.activeSettleTimeoutMs ?? 0);
      const action = decideExistingSetupJobAction(state, options, existing.progress);
      if (action === 'remove') {
        await existing.remove();
      } else if (action === 'enqueue_base') {
        jobId = baseJobId;
      } else if (action === 'enqueue_successor') {
        // BullMQ cannot replace an active deterministic job. An automatically
        // assigned ID would be invisible to later deduplication checks. A
        // stable second slot permits exactly one durable reconciliation behind
        // the active base job.
        if (successorSlotUnavailable) {
          throw new ConflictError(
            'Tournament setup is already settling.',
            'TOURNAMENT_SETUP_IN_PROGRESS',
          );
        }
        jobId = successorJobId;
      } else if (action === 'reject') {
        throw new ConflictError(
          'Tournament setup is already running.',
          'TOURNAMENT_SETUP_IN_PROGRESS',
        );
      } else {
        logInfo('Tournament setup job already active; reusing existing', {
          tournamentId,
          jobId: baseJobId,
          state,
          source,
        });
        return existing;
      }
    }

    await options.prepareEnqueue?.();
    let job;
    try {
      job = await queue.add(
        'tournament-setup',
        jobData,
        jobId === undefined ? undefined : { jobId },
      );
    } catch (addError) {
      // A lost Redis response is ambiguous: the deterministic add may already
      // have committed. Re-read that exact slot before callers replace the
      // prepared processing marker with a false failed state.
      const accepted = jobId === undefined ? null : await queue.getJob(jobId).catch(() => null);
      if (!accepted) throw addError;
      logWarn('Recovered tournament setup job after ambiguous queue add response', {
        tournamentId,
        jobId,
        source,
      });
      job = accepted;
    }

    logInfo('Tournament setup job enqueued', {
      tournamentId,
      jobId: job.id,
      source,
      queue: queue.name,
    });

    return job;
  } catch (error) {
    logError('Failed to enqueue tournament setup job', error, {
      tournamentId,
      source,
    });
    throw error;
  }
}

export function enqueueTournamentSetup(
  season: FplSeasonRef,
  tournamentId: number,
  source: TournamentSetupJobSource = 'create',
  options: EnqueueTournamentSetupOptions = {},
) {
  return withMutationConflictGuard(
    {
      queueName: 'tournament-setup-enqueue',
      jobName: 'tournament-setup-enqueue',
      tournamentId,
      scopes: [tournamentSetupEnqueueScope(tournamentId)],
    },
    () => enqueueTournamentSetupUnlocked(season, tournamentId, source, options),
  );
}
