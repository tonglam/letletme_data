import {
  getTournamentSyncQueue,
  TOURNAMENT_JOBS,
  type TournamentSyncJobName,
  type TournamentSyncJobData,
} from '../queues/tournament-sync.queue';
import {
  getTournamentSyncJobPriority,
  type TournamentSyncPriorityJobName,
} from '../domain/job-priority';
import { redisSingleton } from '../cache/singleton';
import { logError, logInfo } from '../utils/logger';

export type TournamentSyncJobSource = 'cron' | 'manual' | 'cascade';

export type TournamentSyncEnqueueOptions = {
  delay?: number;
  cascadeId?: string;
};

/** Structure cascade jobs that feed tournament MVs and hold tournament-structure:global. */
export const CASCADE_STRUCTURE_BARRIER_JOBS = [
  TOURNAMENT_JOBS.POINTS_RACE,
  TOURNAMENT_JOBS.BATTLE_RACE,
  TOURNAMENT_JOBS.KNOCKOUT,
] as const;

const CASCADE_BARRIER_TTL_SECONDS = 60 * 60; // 1h — longer than any reasonable cascade

function cascadeBarrierKey(cascadeId: string): string {
  return `tournament-cascade:structure-remaining:${cascadeId}`;
}

export function createCascadeId(eventId: number): string {
  return `${eventId}-${Date.now()}`;
}

/**
 * Initialize the structure-completion barrier for one cascade fan-out.
 * Each of points/battle/knockout decrements on success; last one enqueues MV refresh.
 */
export async function initCascadeStructureBarrier(cascadeId: string): Promise<void> {
  const redis = await redisSingleton.getClient();
  await redis.set(
    cascadeBarrierKey(cascadeId),
    String(CASCADE_STRUCTURE_BARRIER_JOBS.length),
    'EX',
    CASCADE_BARRIER_TTL_SECONDS,
  );
}

/**
 * Called after a cascade structure job succeeds. Returns true when this call
 * was the last remaining structure job (caller should enqueue MV refresh).
 */
export async function noteCascadeStructureJobComplete(cascadeId: string): Promise<boolean> {
  const redis = await redisSingleton.getClient();
  const key = cascadeBarrierKey(cascadeId);
  const remaining = await redis.decr(key);
  if (remaining === 0) {
    await redis.del(key);
    return true;
  }
  // Negative means double-complete or missing init — do not enqueue again.
  if (remaining < 0) {
    await redis.del(key);
    logError('Cascade structure barrier went negative; skipping MV enqueue', undefined, {
      cascadeId,
      remaining,
    });
  }
  return false;
}

async function enqueueTournamentSyncJob(
  jobName: TournamentSyncJobName,
  eventId: number,
  source: TournamentSyncJobSource = 'cron',
  options: TournamentSyncEnqueueOptions = {},
) {
  try {
    const tier = getTournamentSyncJobPriority(jobName as TournamentSyncPriorityJobName);
    const queue = getTournamentSyncQueue(tier);
    const jobData: TournamentSyncJobData = {
      eventId,
      source,
      triggeredAt: new Date().toISOString(),
      ...(options.cascadeId ? { cascadeId: options.cascadeId } : {}),
    };

    // Use unique IDs so recurring schedules are not deduped by completed jobs.
    const jobId = `${jobName}-e${eventId}-${Date.now()}`;

    const job = await queue.add(jobName, jobData, {
      jobId,
      delay: options.delay,
    });

    logInfo('Tournament sync job enqueued', {
      jobId: job.id,
      jobName,
      eventId,
      source,
      tier,
      queue: queue.name,
      cascadeId: options.cascadeId,
    });

    return job;
  } catch (error) {
    const tier = getTournamentSyncJobPriority(jobName as TournamentSyncPriorityJobName);
    logError('Failed to enqueue tournament sync job', error, {
      jobName,
      eventId,
      source,
      tier,
    });
    throw error;
  }
}

// Base job (triggers cascade)
export const enqueueTournamentEventResults = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.EVENT_RESULTS, eventId, source);

// Cascade jobs
export const enqueueTournamentPointsRace = (
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.POINTS_RACE, eventId, source, options);

export const enqueueTournamentBattleRace = (
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.BATTLE_RACE, eventId, source, options);

export const enqueueTournamentKnockout = (
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.KNOCKOUT, eventId, source, options);

export const enqueueTournamentTransfersPost = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.TRANSFERS_POST, eventId, source);

export const enqueueTournamentCupResults = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.CUP_RESULTS, eventId, source);

export const enqueueTournamentSelectionStats = (
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: { delay?: number },
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.SELECTION_STATS, eventId, source, options);

// Materialized view refresh (after structure cascade barrier completes)
export const enqueueTournamentMaterializedViewsRefresh = (
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.MATERIALIZED_VIEWS_REFRESH, eventId, source, options);

// Independent jobs
export const enqueueTournamentEventPicks = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.EVENT_PICKS, eventId, source);

export const enqueueTournamentTransfersPre = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.TRANSFERS_PRE, eventId, source);

export const enqueueTournamentInfo = (eventId: number, source?: TournamentSyncJobSource) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.INFO, eventId, source);
