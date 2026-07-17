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

function cascadeSlotKey(cascadeId: string, jobKey: string): string {
  return `tournament-cascade:structure-done:${cascadeId}:${jobKey}`;
}

function cascadeRefreshPendingKey(cascadeId: string): string {
  return `tournament-cascade:refresh-pending:${cascadeId}`;
}

function cascadeRefreshDoneKey(cascadeId: string): string {
  return `tournament-cascade:refresh-enqueued:${cascadeId}`;
}

function cascadeRefreshLeaseKey(cascadeId: string): string {
  return `tournament-cascade:refresh-lease:${cascadeId}`;
}

export function createCascadeId(eventId: number): string {
  return `${eventId}-${Date.now()}`;
}

/**
 * Initialize the structure-completion barrier for one cascade fan-out.
 * Each of points/battle/knockout claims one slot on success; when all three
 * are done a durable refresh-pending flag is set for MV enqueue.
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
 * Atomic slot claim + remaining DECR + optional refresh-pending set.
 *
 * Returns:
 *  -2 already claimed (idempotent retry — no DECR)
 *  -1 remaining went negative (logged)
 *   0 last slot — refresh-pending set
 *  >0 slots still remaining
 *
 * Must be one Redis script so a crash after SET NX cannot strand the cascade
 * without DECR (Codex P2 atomic barrier).
 */
const NOTE_CASCADE_STRUCTURE_COMPLETE_LUA = `
local claimed = redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX')
if not claimed then
  return -2
end
local remaining = redis.call('DECR', KEYS[2])
if remaining == 0 then
  redis.call('DEL', KEYS[2])
  redis.call('SET', KEYS[3], '1', 'EX', ARGV[1])
  return 0
end
if remaining < 0 then
  redis.call('DEL', KEYS[2])
  return -1
end
return remaining
`;

/**
 * Record that one structure barrier participant finished.
 *
 * `jobKey` must be stable per logical participant (e.g. job name, or
 * `enqueue-failed:tournament-points-race`). Slot claim + DECR + pending flag
 * run in one Lua script so retries cannot double-DECR and crashes cannot
 * strand a claimed slot without decrementing.
 *
 * When the last slot is claimed, sets a durable `refresh-pending` flag so a
 * later crash still allows a retry to enqueue MV refresh.
 */
export async function noteCascadeStructureJobComplete(
  cascadeId: string,
  jobKey: string,
): Promise<void> {
  const redis = await redisSingleton.getClient();
  const result = (await redis.eval(
    NOTE_CASCADE_STRUCTURE_COMPLETE_LUA,
    3,
    cascadeSlotKey(cascadeId, jobKey),
    cascadeBarrierKey(cascadeId),
    cascadeRefreshPendingKey(cascadeId),
    String(CASCADE_BARRIER_TTL_SECONDS),
  )) as number;

  if (result === -2) {
    logInfo('Cascade structure barrier slot already claimed (idempotent skip)', {
      cascadeId,
      jobKey,
    });
    return;
  }
  if (result === -1) {
    logError('Cascade structure barrier went negative', undefined, {
      cascadeId,
      jobKey,
      remaining: result,
    });
  }
}

/**
 * Claim the right to enqueue the cascade MV refresh.
 * True only when structure barrier is complete (pending) and refresh has not
 * been successfully enqueued yet. Concurrent callers: only one gets the lease.
 * On enqueue failure, call `releaseCascadeRefreshEnqueueClaim` so a retry can re-claim.
 */
export async function tryClaimCascadeRefreshEnqueue(cascadeId: string): Promise<boolean> {
  const redis = await redisSingleton.getClient();
  if (await redis.exists(cascadeRefreshDoneKey(cascadeId))) {
    return false;
  }
  if (!(await redis.exists(cascadeRefreshPendingKey(cascadeId)))) {
    return false;
  }
  const lease = await redis.set(cascadeRefreshLeaseKey(cascadeId), '1', 'EX', 120, 'NX');
  return lease === 'OK';
}

/** Mark MV refresh as successfully enqueued (durable; retries will no-op). */
export async function markCascadeRefreshEnqueued(cascadeId: string): Promise<void> {
  const redis = await redisSingleton.getClient();
  await redis.set(cascadeRefreshDoneKey(cascadeId), '1', 'EX', CASCADE_BARRIER_TTL_SECONDS);
  await redis.del(cascadeRefreshPendingKey(cascadeId));
  await redis.del(cascadeRefreshLeaseKey(cascadeId));
}

/** Release enqueue lease after a failed queue.add so BullMQ retries can try again. */
export async function releaseCascadeRefreshEnqueueClaim(cascadeId: string): Promise<void> {
  const redis = await redisSingleton.getClient();
  await redis.del(cascadeRefreshLeaseKey(cascadeId));
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
