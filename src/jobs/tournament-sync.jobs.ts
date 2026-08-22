import { randomUUID } from 'node:crypto';
import {
  tournamentSyncQueue,
  TOURNAMENT_JOBS,
  type TournamentSyncJobName,
  type TournamentSyncJobData,
} from '../queues/tournament-sync.queue';
import type { TournamentFinalizationTarget } from '../domain/tournament';
import type { FplSeasonRef } from '../domain/fpl-season';
import { queueRedisSingleton } from '../queues/redis';
import { logError, logInfo, logWarn } from '../utils/logger';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';

export type TournamentSyncJobSource =
  | 'cron'
  | 'manual'
  | 'cascade'
  | 'watchdog'
  | 'catchup'
  | 'reconcile';

export type TournamentSyncEnqueueOptions = {
  delay?: number;
  cascadeId?: string;
  jobId?: string;
  finalizationTargets?: TournamentFinalizationTarget[];
  tournamentId?: number;
  resumeAfterSetup?: boolean;
  resumeMarker?: string;
  allowInactive?: boolean;
  settleBoundaryFailure?: boolean;
  allowUnlockedOfficialH2HRecovery?: boolean;
  expectedProgressMarker?: string | null;
  operationId?: string;
  obligationId?: string;
  obligationGeneration?: number;
};

async function hasPendingOfficialH2HJob(season: FplSeasonRef, eventId: number): Promise<boolean> {
  try {
    const jobs = await tournamentSyncQueue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.some(
      (job) =>
        job.name === TOURNAMENT_JOBS.OFFICIAL_H2H &&
        job.data.seasonId === season.seasonId &&
        job.data.eventId === eventId,
    );
  } catch (error) {
    logError('Failed to check pending official H2H jobs', error, {
      season: season.seasonCode,
      eventId,
    });
    return false;
  }
}

/** Cascade jobs that must finish before event publication can finish tournaments. */
export const CASCADE_COMPLETION_BARRIER_JOBS = [
  TOURNAMENT_JOBS.POINTS_RACE,
  TOURNAMENT_JOBS.BATTLE_RACE,
  TOURNAMENT_JOBS.KNOCKOUT,
  TOURNAMENT_JOBS.TRANSFERS_POST,
  TOURNAMENT_JOBS.CUP_RESULTS,
  TOURNAMENT_JOBS.SELECTION_STATS,
] as const;

/**
 * Slot TTL: longer than the 24h post-match scheduling window and the 48h
 * failed-job retention window. Each completed participant refreshes the
 * role-slot TTL, so a delayed final participant cannot strand the barrier
 * merely because the first participants finished a day earlier.
 */
export const CASCADE_BARRIER_TTL_SECONDS = 7 * 24 * 60 * 60;
const CASCADE_REFRESH_LEASE_TTL_SECONDS = 120;

function cascadeSlotKey(cascadeId: string, jobKey: string): string {
  return `llm:queue:coordination:tournament-cascade:structure-done:${cascadeId}:${jobKey}`;
}

function cascadeRefreshPendingKey(cascadeId: string): string {
  return `llm:queue:coordination:tournament-cascade:refresh-pending:${cascadeId}`;
}

function cascadeRefreshDoneKey(cascadeId: string): string {
  return `llm:queue:coordination:tournament-cascade:refresh-enqueued:${cascadeId}`;
}

function cascadeRefreshLeaseKey(cascadeId: string): string {
  return `llm:queue:coordination:tournament-cascade:refresh-lease:${cascadeId}`;
}

function cascadeMetaKey(cascadeId: string): string {
  return `llm:queue:coordination:tournament-cascade:meta:${cascadeId}`;
}

export function createCascadeId(season: FplSeasonRef, eventId: number): string {
  return `${season.seasonCode}-${eventId}-${Date.now()}`;
}

/**
 * Mark a cascade fan-out as started (observability + TTL anchor).
 * Completion does not rely on a DECR counter — it counts per-role slot keys
 * so an expired counter cannot strand the barrier.
 */
export async function initCascadeStructureBarrier(cascadeId: string): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.set(
    cascadeMetaKey(cascadeId),
    String(CASCADE_COMPLETION_BARRIER_JOBS.length),
    'EX',
    CASCADE_BARRIER_TTL_SECONDS,
  );
}

/**
 * Atomic slot claim + role completion count + optional refresh-pending.
 *
 * KEYS[1] = this job's slot
 * KEYS[2] = refresh-pending
 * KEYS[3..] = for each role: success slot, enqueue-failed slot
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
for i = 3, #KEYS, 2 do
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
local required = (#KEYS - 2) / 2
if done >= required then
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[1])
  return 0
end
return required - done
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
  const redis = await queueRedisSingleton.getClient();
  const ttl = String(CASCADE_BARRIER_TTL_SECONDS);
  const roles = CASCADE_COMPLETION_BARRIER_JOBS;
  const roleKeys = roles.flatMap((role) => [
    cascadeSlotKey(cascadeId, role),
    cascadeSlotKey(cascadeId, `enqueue-failed:${role}`),
  ]);
  const result = (await redis.eval(
    NOTE_CASCADE_STRUCTURE_COMPLETE_LUA,
    2 + roleKeys.length,
    cascadeSlotKey(cascadeId, jobKey),
    cascadeRefreshPendingKey(cascadeId),
    ...roleKeys,
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
  const redis = await queueRedisSingleton.getClient();
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
  const redis = await queueRedisSingleton.getClient();
  await redis.set(cascadeRefreshDoneKey(cascadeId), '1', 'EX', CASCADE_BARRIER_TTL_SECONDS);
  await redis.del(cascadeRefreshPendingKey(cascadeId));
  await redis.del(cascadeRefreshLeaseKey(cascadeId));
}

/** Release enqueue lease after a failed queue.add so BullMQ retries can try again. */
export async function releaseCascadeRefreshEnqueueClaim(cascadeId: string): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.del(cascadeRefreshLeaseKey(cascadeId));
}

async function enqueueTournamentSyncJob(
  jobName: TournamentSyncJobName,
  season: FplSeasonRef,
  eventId: number,
  source: TournamentSyncJobSource = 'cron',
  options: TournamentSyncEnqueueOptions = {},
) {
  try {
    const queue = tournamentSyncQueue;
    const jobData: TournamentSyncJobData = {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      eventId,
      source,
      triggeredAt: new Date().toISOString(),
      runId: randomUUID(),
      ...(options.obligationId ? { obligationId: options.obligationId } : {}),
      ...(options.obligationGeneration === undefined
        ? {}
        : { obligationGeneration: options.obligationGeneration }),
      ...(options.cascadeId ? { cascadeId: options.cascadeId } : {}),
      ...(options.finalizationTargets
        ? {
            finalizationTargets: [
              ...new Map(
                options.finalizationTargets
                  .filter(
                    (target) =>
                      target.tournamentId > 0 &&
                      Number.isFinite(Date.parse(target.standingsReadyAt)) &&
                      (!target.resultsFreshAfter ||
                        Number.isFinite(Date.parse(target.resultsFreshAfter))),
                  )
                  .map((target) => [target.tournamentId, target]),
              ).values(),
            ],
          }
        : {}),
      ...(options.tournamentId ? { tournamentId: options.tournamentId } : {}),
      ...(options.resumeAfterSetup ? { resumeAfterSetup: true } : {}),
      ...(options.resumeMarker ? { resumeMarker: options.resumeMarker } : {}),
      ...(options.allowInactive ? { allowInactive: true } : {}),
      ...(options.settleBoundaryFailure ? { settleBoundaryFailure: true } : {}),
      ...(options.allowUnlockedOfficialH2HRecovery
        ? { allowUnlockedOfficialH2HRecovery: true }
        : {}),
      ...(options.expectedProgressMarker !== undefined
        ? { expectedProgressMarker: options.expectedProgressMarker }
        : {}),
    };

    // Callers may provide a deterministic ID for bounded recurring slots.
    // Other cron, manual, and cascade runs retain unique IDs.
    const jobId = options.jobId
      ? `${season.seasonCode}-${options.jobId}`
      : `${jobName}-${season.seasonCode}-e${eventId}-${Date.now()}`;

    const manualCleanup = source === 'manual';
    const job = await queue.add(jobName, jobData, {
      jobId,
      delay: options.delay,
      ...(options.jobId
        ? {
            removeOnComplete: manualCleanup ? true : BULL_COMPLETED_RETENTION,
            removeOnFail: manualCleanup ? true : BULL_FAILED_RETENTION,
          }
        : {}),
    });

    logInfo('Tournament sync job enqueued', {
      jobId: job.id,
      jobName,
      eventId,
      source,
      queue: queue.name,
      cascadeId: options.cascadeId,
      tournamentCount: options.finalizationTargets?.length,
    });

    return job;
  } catch (error) {
    logError('Failed to enqueue tournament sync job', error, {
      jobName,
      eventId,
      source,
    });
    throw error;
  }
}

// Base job (triggers cascade)
export const enqueueTournamentEventResults = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.EVENT_RESULTS, season, eventId, source, options);

// Cascade jobs
export const enqueueTournamentPointsRace = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.POINTS_RACE, season, eventId, source, options);

export const enqueueTournamentBattleRace = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.BATTLE_RACE, season, eventId, source, options);

export const enqueueTournamentOfficialH2H = async (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => {
  if (source === 'cron' && (await hasPendingOfficialH2HJob(season, eventId))) {
    logInfo('Official H2H job already pending; skipping enqueue', {
      season: season.seasonCode,
      eventId,
    });
    return null;
  }
  return enqueueTournamentSyncJob(TOURNAMENT_JOBS.OFFICIAL_H2H, season, eventId, source, options);
};

export const enqueueTournamentKnockout = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.KNOCKOUT, season, eventId, source, options);

export const enqueueTournamentTransfersPost = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.TRANSFERS_POST, season, eventId, source, options);

export const enqueueTournamentCupResults = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.CUP_RESULTS, season, eventId, source, options);

export const enqueueTournamentSelectionStats = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.SELECTION_STATS, season, eventId, source, options);

// Materialized view refresh (after structure cascade barrier completes)
export const enqueueTournamentMaterializedViewsRefresh = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) =>
  enqueueTournamentSyncJob(
    TOURNAMENT_JOBS.MATERIALIZED_VIEWS_REFRESH,
    season,
    eventId,
    source,
    options,
  );

// Independent jobs
export const enqueueTournamentEventPicks = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.EVENT_PICKS, season, eventId, source, options);

export const enqueueTournamentTransfersPre = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.TRANSFERS_PRE, season, eventId, source, options);

export const enqueueTournamentInfo = (
  season: FplSeasonRef,
  eventId: number,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) => enqueueTournamentSyncJob(TOURNAMENT_JOBS.INFO, season, eventId, source, options);

export const enqueueTournamentRosterSync = (
  season: FplSeasonRef,
  source?: TournamentSyncJobSource,
  options?: TournamentSyncEnqueueOptions,
) =>
  enqueueTournamentSyncJob(TOURNAMENT_JOBS.ROSTER_SYNC, season, 0, source, {
    ...options,
    jobId: options?.jobId ?? `tournament-roster-sync-${new Date().toISOString().slice(0, 10)}`,
  });

export const enqueueTournamentRosterReconcile = async (
  season: FplSeasonRef,
  tournamentId: number,
  source: TournamentSyncJobSource = 'manual',
  options?: {
    resumeAfterSetup?: boolean;
    resumeMarker?: string;
    allowInactive?: boolean;
    settleBoundaryFailure?: boolean;
    allowUnlockedOfficialH2HRecovery?: boolean;
    expectedProgressMarker?: string | null;
    operationId?: string;
  },
) => {
  const logicalJobId = getTournamentRosterReconcileLogicalJobId(
    tournamentId,
    options?.resumeAfterSetup,
    options?.resumeMarker,
    options?.allowInactive,
    options?.operationId,
    options?.expectedProgressMarker,
    options?.allowUnlockedOfficialH2HRecovery,
  );
  const stableJobId = `${season.seasonCode}-${logicalJobId}`;

  if (!options?.operationId) {
    const existing = await tournamentSyncQueue.getJob(stableJobId);
    if (existing) {
      const state = await existing.getState();
      if (['waiting', 'waiting-children', 'delayed', 'active', 'paused'].includes(state)) {
        logInfo('Tournament roster reconcile already in flight; reusing existing', {
          tournamentId,
          jobId: existing.id,
          state,
          source,
        });
        return existing;
      }
      // Completed/failed jobs are retained for observability, but must not
      // prevent a later explicit retry from reusing the stable in-flight slot.
      await existing.remove();
    }
  }

  return enqueueTournamentSyncJob(TOURNAMENT_JOBS.ROSTER_RECONCILE, season, 0, source, {
    tournamentId,
    resumeAfterSetup: options?.resumeAfterSetup,
    resumeMarker: options?.resumeMarker,
    allowInactive: options?.allowInactive,
    settleBoundaryFailure: options?.settleBoundaryFailure,
    allowUnlockedOfficialH2HRecovery: options?.allowUnlockedOfficialH2HRecovery,
    expectedProgressMarker: options?.expectedProgressMarker,
    jobId: logicalJobId,
  });
};

export async function findTournamentRosterReconcileJob(
  season: FplSeasonRef,
  tournamentId: number,
  resumeAfterSetup: boolean,
  resumeMarker?: string,
  expectedProgressMarker?: string | null,
) {
  const logicalJobId = getTournamentRosterReconcileLogicalJobId(
    tournamentId,
    resumeAfterSetup,
    resumeMarker,
    undefined,
    undefined,
    expectedProgressMarker,
  );
  const job = await tournamentSyncQueue.getJob(`${season.seasonCode}-${logicalJobId}`);
  if (!job) return null;

  // BullMQ retains completed and failed jobs for observability.  A retained
  // terminal job is not an in-flight resume and must not block a later retry
  // or make an ambiguous enqueue look accepted.
  const state = await job.getState();
  return ['waiting', 'waiting-children', 'delayed', 'active', 'paused'].includes(state)
    ? job
    : null;
}

function getTournamentRosterReconcileLogicalJobId(
  tournamentId: number,
  resumeAfterSetup?: boolean,
  resumeMarker?: string,
  allowInactive?: boolean,
  operationId?: string,
  expectedProgressMarker?: string | null,
  allowUnlockedOfficialH2HRecovery?: boolean,
): string {
  if (operationId) return `tournament-roster-reconcile-${tournamentId}-${operationId}`;
  if (!resumeAfterSetup) {
    const recoveryPart = allowUnlockedOfficialH2HRecovery ? '-unlocked-h2h-recovery' : '';
    if (expectedProgressMarker !== undefined) {
      const markerPart = (expectedProgressMarker ?? 'no-marker').replace(/[^a-zA-Z0-9_-]/g, '_');
      return `tournament-roster-reconcile-sync-${allowInactive ? 'inactive' : 'active'}${recoveryPart}-${tournamentId}-${markerPart}`;
    }
    return `tournament-roster-reconcile-sync-${allowInactive ? 'inactive' : 'active'}${recoveryPart}-${tournamentId}`;
  }
  const markerPart = (resumeMarker ?? 'missing-marker').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `tournament-roster-reconcile-resume-${tournamentId}-${markerPart}`;
}

export async function cancelWaitingTournamentRosterReconcileJobs(
  tournamentId: number,
): Promise<number> {
  let removed = 0;
  const jobs = await tournamentSyncQueue.getJobs(['waiting', 'delayed', 'paused']);
  for (const job of jobs) {
    if (job.name !== TOURNAMENT_JOBS.ROSTER_RECONCILE || job.data.tournamentId !== tournamentId) {
      continue;
    }
    try {
      await job.remove();
      removed += 1;
    } catch (error) {
      logWarn('Unable to remove waiting tournament roster reconcile job', {
        tournamentId,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return removed;
}
