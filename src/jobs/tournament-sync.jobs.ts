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

/** Slot TTL: long enough for p0 backlog / setup / worker outage (Codex P2). */
const CASCADE_BARRIER_TTL_SECONDS = 24 * 60 * 60; // 24h
const CASCADE_REFRESH_LEASE_TTL_SECONDS = 120;

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

function cascadeMetaKey(cascadeId: string): string {
  return `tournament-cascade:meta:${cascadeId}`;
}

export function createCascadeId(eventId: number): string {
  return `${eventId}-${Date.now()}`;
}

/**
 * Mark a cascade fan-out as started (observability + TTL anchor).
 * Completion does not rely on a DECR counter — it counts per-role slot keys
 * so an expired counter cannot strand the barrier.
 */
export async function initCascadeStructureBarrier(cascadeId: string): Promise<void> {
  const redis = await redisSingleton.getClient();
  await redis.set(
    cascadeMetaKey(cascadeId),
    String(CASCADE_STRUCTURE_BARRIER_JOBS.length),
    'EX',
    CASCADE_BARRIER_TTL_SECONDS,
  );
}

/**
 * Atomic slot claim + role completion count + optional refresh-pending.
 *
 * KEYS[1] = this job's slot
 * KEYS[2] = refresh-pending
 * KEYS[3..8] = for each of 3 roles: success slot, enqueue-failed slot
 * ARGV[1] = TTL seconds
 *
 * A role is done if either its success or enqueue-failed slot exists.
 * No shared DECR counter — immune to counter TTL expiry (Codex P2).
 *
 * Returns: -2 already claimed; 0 all roles done (pending set); >0 remaining roles
 */
const NOTE_CASCADE_STRUCTURE_COMPLETE_LUA = `
local claimed = redis.call('SET', KEYS[1], '1', 'EX', ARGV[1], 'NX')
if not claimed then
  return -2
end
local done = 0
for i = 3, 8, 2 do
  local okKey = KEYS[i]
  local failKey = KEYS[i + 1]
  if redis.call('EXISTS', okKey) == 1 or redis.call('EXISTS', failKey) == 1 then
    done = done + 1
    if redis.call('EXISTS', okKey) == 1 then
      redis.call('EXPIRE', okKey, ARGV[1])
    end
    if redis.call('EXISTS', failKey) == 1 then
      redis.call('EXPIRE', failKey, ARGV[1])
    end
  end
end
if done >= 3 then
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
  return 0
end
return 3 - done
`;

/**
 * Atomic claim for MV refresh enqueue.
 * KEYS[1]=done KEYS[2]=pending KEYS[3]=lease  ARGV[1]=lease TTL
 * Returns: 1 claimed, 2 already-enqueued, 3 not-pending, 4 lease-busy
 */
const TRY_CLAIM_CASCADE_REFRESH_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 2
end
if redis.call('EXISTS', KEYS[2]) == 0 then
  return 3
end
local lease = redis.call('SET', KEYS[3], '1', 'EX', ARGV[1], 'NX')
if not lease then
  return 4
end
-- Recheck done after lease to close the race with markCascadeRefreshEnqueued.
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('DEL', KEYS[3])
  return 2
end
return 1
`;

/**
 * Record that one structure barrier participant finished.
 *
 * `jobKey` must be stable per logical participant (e.g. job name, or
 * `enqueue-failed:tournament-points-race`). Uses per-role slot keys (not a
 * shared DECR counter) so long waits cannot expire the barrier state.
 */
export async function noteCascadeStructureJobComplete(
  cascadeId: string,
  jobKey: string,
): Promise<void> {
  const redis = await redisSingleton.getClient();
  const ttl = String(CASCADE_BARRIER_TTL_SECONDS);
  const roles = CASCADE_STRUCTURE_BARRIER_JOBS;
  const result = (await redis.eval(
    NOTE_CASCADE_STRUCTURE_COMPLETE_LUA,
    8,
    cascadeSlotKey(cascadeId, jobKey),
    cascadeRefreshPendingKey(cascadeId),
    cascadeSlotKey(cascadeId, roles[0]),
    cascadeSlotKey(cascadeId, `enqueue-failed:${roles[0]}`),
    cascadeSlotKey(cascadeId, roles[1]),
    cascadeSlotKey(cascadeId, `enqueue-failed:${roles[1]}`),
    cascadeSlotKey(cascadeId, roles[2]),
    cascadeSlotKey(cascadeId, `enqueue-failed:${roles[2]}`),
    ttl,
  )) as number;

  // Keep meta alive while structure jobs complete.
  await redis.expire(cascadeMetaKey(cascadeId), CASCADE_BARRIER_TTL_SECONDS);

  if (result === -2) {
    logInfo('Cascade structure barrier slot already claimed (idempotent skip)', {
      cascadeId,
      jobKey,
    });
    return;
  }
  if (result === 0) {
    logInfo('Cascade structure barrier complete; refresh pending', { cascadeId, jobKey });
  }
}

/**
 * Result of trying to claim the MV refresh enqueue lease.
 * - claimed: this caller owns the lease and should enqueue
 * - already-enqueued: durable done flag set; no work
 * - not-pending: barrier not finished yet
 * - lease-busy: another worker holds the lease (may be dead mid-enqueue);
 *   caller should throw so BullMQ retries instead of silently succeeding
 */
export type CascadeRefreshClaimResult =
  | 'claimed'
  | 'already-enqueued'
  | 'not-pending'
  | 'lease-busy';

/**
 * Claim the right to enqueue the cascade MV refresh (atomic done/pending/lease).
 */
export async function tryClaimCascadeRefreshEnqueue(
  cascadeId: string,
): Promise<CascadeRefreshClaimResult> {
  const redis = await redisSingleton.getClient();
  const code = (await redis.eval(
    TRY_CLAIM_CASCADE_REFRESH_LUA,
    3,
    cascadeRefreshDoneKey(cascadeId),
    cascadeRefreshPendingKey(cascadeId),
    cascadeRefreshLeaseKey(cascadeId),
    String(CASCADE_REFRESH_LEASE_TTL_SECONDS),
  )) as number;

  switch (code) {
    case 1:
      return 'claimed';
    case 2:
      return 'already-enqueued';
    case 3:
      return 'not-pending';
    case 4:
      return 'lease-busy';
    default:
      logError('Unexpected cascade refresh claim code', undefined, { cascadeId, code });
      return 'not-pending';
  }
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
