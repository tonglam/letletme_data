import {
  getTournamentSetupQueue,
  tournamentSetupQueuesByTier,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import { getTournamentSetupJobPriority } from '../domain/job-priority';
import { logError, logInfo, logWarn } from '../utils/logger';

export type TournamentSetupJobSource = 'create' | 'manual' | 'watchdog' | 'roster' | 'resume';
export interface EnqueueTournamentSetupOptions {
  forceNew?: boolean;
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
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      } else if (options.forceNew) {
        if (state === 'waiting' || state === 'delayed') {
          await existing.remove();
        } else {
          logInfo('Tournament setup is already active; reusing its lifecycle job', {
            tournamentId,
            existingJobId: existing.id,
            state,
            source,
          });
          return existing;
        }
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
