import {
  getTournamentSetupQueue,
  type TournamentSetupJobData,
} from '../queues/tournament-setup.queue';
import { getTournamentSetupJobPriority } from '../domain/job-priority';
import { logError, logInfo, logWarn } from '../utils/logger';

export type TournamentSetupJobSource = 'create' | 'manual' | 'watchdog';
export interface EnqueueTournamentSetupOptions {
  forceNew?: boolean;
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
    let jobId = baseJobId;
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      } else if (options.forceNew) {
        if (state === 'waiting' || state === 'delayed' || state === 'paused') {
          await existing.remove();
        } else {
          jobId = `${baseJobId}-${Date.now()}`;
          logWarn('Tournament setup active job detected, enqueueing forced replacement job', {
            tournamentId,
            existingJobId: existing.id,
            replacementJobId: jobId,
            state,
            source,
          });
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
