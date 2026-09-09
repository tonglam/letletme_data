import {
  tournamentSetupQueue,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentSetupEnqueueScope } from '../domain/mutation-scope';
import { ConflictError } from '../utils/errors';
import { logError, logInfo, logWarn } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';

export type TournamentSetupJobSource = 'create' | 'manual' | 'watchdog' | 'roster' | 'resume';
export interface EnqueueTournamentSetupOptions {
  forceNew?: boolean;
  /**
   * Prepare durable state before queue admission. A returned marker is copied
   * into the job identity/data as a prepared retry marker so the handoff
   * cannot be mistaken for an unmarked manual retry.
   */
  prepareEnqueue?: () => Promise<void | string>;
  /**
   * Queue a distinct successor when an active job remains ambiguous after the
   * settle window. Callers must fence the durable publication marker with the
   * tournament lifecycle scope before invoking this after-commit handoff; the
   * successor then waits behind the active job and reads the newly published
   * state.
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
  /** Existing marker-suffixed slot to inspect before preparing a new retry. */
  admissionMarker?: string;
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

export async function findTournamentSetupJob(
  season: FplSeasonRef,
  tournamentId: number,
  resumeMarker?: string | null,
) {
  const { baseJobId, successorJobId } = getTournamentSetupJobIds(
    season,
    tournamentId,
    resumeMarker ?? undefined,
  );
  const jobs = await Promise.all([
    tournamentSetupQueue.getJob(baseJobId),
    tournamentSetupQueue.getJob(successorJobId),
  ]);
  for (const job of jobs) {
    if (!job) continue;
    const state = await job.getState();
    if (['waiting', 'waiting-children', 'delayed', 'active', 'paused'].includes(state)) return job;
  }
  return null;
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
    if (await isQueueDrainOnly(queue.name)) {
      throw new QueueDrainOnlyError(queue.name);
    }
    let preparedRetryMarker: string | undefined;
    const admissionMarker = options.resumeMarker ?? options.admissionMarker;
    const { baseJobId, successorJobId } = getTournamentSetupJobIds(
      season,
      tournamentId,
      admissionMarker,
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

    if (options.prepareEnqueue) {
      // Durable preparation is serialized briefly. Queue inspection and Redis
      // admission intentionally happen after this transaction commits so a
      // slow/unavailable queue cannot retain a PostgreSQL mutation lock.
      const preparedMarker = await withMutationScopes(
        {
          queueName: 'tournament-setup-enqueue',
          jobName: 'prepare-tournament-setup-enqueue',
          tournamentId,
          scopes: [tournamentSetupEnqueueScope(tournamentId)],
        },
        options.prepareEnqueue,
      );
      if (typeof preparedMarker === 'string' && preparedMarker.length > 0) {
        preparedRetryMarker = preparedMarker;
        // A preparation callback may create a new durable marker. Its
        // deterministic job slot must carry that marker, otherwise the worker
        // would classify the prepared handoff as an unmarked manual retry.
        jobId = getTournamentSetupJobIds(
          season,
          tournamentId,
          options.resumeMarker ?? preparedRetryMarker,
        ).baseJobId;
      }
    }
    const jobData: TournamentSetupJobData = {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      tournamentId,
      source,
      triggeredAt: new Date().toISOString(),
      ...(options.resumeMarker ? { resumeMarker: options.resumeMarker } : {}),
      ...(preparedRetryMarker ? { preparedRetryMarker } : {}),
    };
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
  // Queue inspection and admission must not run inside a database mutation
  // scope. Callers that need a durable marker use prepareEnqueue above, which
  // holds the scope only for that short database write.
  return enqueueTournamentSetupUnlocked(season, tournamentId, source, options);
}
