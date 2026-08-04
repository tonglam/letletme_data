import {
  getTournamentSetupQueue,
  tournamentSetupQueuesByTier,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import { getTournamentSetupJobPriority } from '../domain/job-priority';
import { ConflictError } from '../utils/errors';
import { logError, logInfo, logWarn } from '../utils/logger';

export type TournamentSetupJobSource = 'create' | 'manual' | 'watchdog' | 'roster' | 'resume';
export interface EnqueueTournamentSetupOptions {
  forceNew?: boolean;
  prepareEnqueue?: () => Promise<void>;
  /** Reuse an active worker known to be waiting behind the caller's lifecycle lock. */
  reuseActive?: boolean;
  /**
   * Only callers already holding the tournament lifecycle lock may use this.
   * It bridges the short interval between a worker releasing that lock and
   * BullMQ recording the job as completed.
   */
  activeSettleTimeoutMs?: number;
}

export type ExistingSetupJobAction = 'remove' | 'reuse' | 'reject';

export function decideExistingSetupJobAction(
  state: string,
  options: Pick<EnqueueTournamentSetupOptions, 'forceNew' | 'prepareEnqueue' | 'reuseActive'>,
): ExistingSetupJobAction {
  if (state === 'completed' || state === 'failed') return 'remove';
  if (!options.forceNew) return 'reuse';
  if (state === 'waiting' || state === 'delayed') return 'remove';
  if (state === 'active' && options.reuseActive) return 'reuse';
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
  const queues = [...new Set(Object.values(tournamentSetupQueuesByTier))];
  let removed = 0;
  for (const queue of queues) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'paused']);
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
  }
  return removed;
}

export async function enqueueTournamentSetup(
  tournamentId: number,
  source: TournamentSetupJobSource = 'create',
  options: EnqueueTournamentSetupOptions = {},
) {
  try {
    const tier = getTournamentSetupJobPriority('tournament-setup');
    const queue = getTournamentSetupQueue(tier);
    const jobData: TournamentSetupJobData = {
      tournamentId,
      source,
      triggeredAt: new Date().toISOString(),
    };

    const baseJobId = `tournament-setup-${tournamentId}`;
    const existing = await queue.getJob(baseJobId);
    const jobId = baseJobId;
    if (existing) {
      const state = await waitForActiveJobToSettle(existing, options.activeSettleTimeoutMs ?? 0);
      const action = decideExistingSetupJobAction(state, options);
      if (action === 'remove') {
        await existing.remove();
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
    const job = await queue.add('tournament-setup', jobData, {
      jobId,
    });

    logInfo('Tournament setup job enqueued', {
      tournamentId,
      jobId: job.id,
      source,
      tier,
      queue: queue.name,
    });

    return job;
  } catch (error) {
    logError('Failed to enqueue tournament setup job', error, {
      tournamentId,
      source,
      tier: getTournamentSetupJobPriority('tournament-setup'),
    });
    throw error;
  }
}
