import type { Job } from 'bullmq';

import type { FplSeasonRef } from '../domain/fpl-season';
import {
  loadManagerLiveHotScope,
  managerLiveDispatchEntryChunks,
  MANAGER_LIVE_REFRESH_BUCKET_MS,
  managerLiveRefreshJobId,
  normalizeManagerLiveEntryIds,
  writeManagerLiveHotScope,
  type ManagerLiveRefreshScope,
} from '../domain/manager-live-refresh';
import {
  MANAGER_LIVE_JOBS,
  MANAGER_LIVE_JOB_VERSION,
  managerLiveQueue,
  type ManagerLiveJobData,
} from '../queues/manager-live.queue';
import { queueRedisSingleton } from '../queues/redis';
import { logError, logInfo } from '../utils/logger';

export async function markManagerLiveScopeHot(scope: ManagerLiveRefreshScope): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await writeManagerLiveHotScope(redis, scope);
}

export async function readHotManagerLiveScope(
  scope: ManagerLiveRefreshScope,
): Promise<ManagerLiveRefreshScope | null> {
  const redis = await queueRedisSingleton.getClient();
  return loadManagerLiveHotScope(redis, scope);
}

async function addManagerLiveRefresh(
  scope: ManagerLiveRefreshScope,
  source: ManagerLiveJobData['source'],
  runAt: Date,
  classicStandingsPage?: number | null,
): Promise<Job<ManagerLiveJobData>> {
  const now = Date.now();
  const data: ManagerLiveJobData = {
    version: MANAGER_LIVE_JOB_VERSION,
    seasonId: scope.seasonId,
    seasonCode: scope.seasonCode,
    eventId: scope.eventId,
    entryIds: normalizeManagerLiveEntryIds(scope.entryIds),
    ...(scope.tournamentId === undefined ? {} : { tournamentId: scope.tournamentId }),
    ...(classicStandingsPage === undefined || classicStandingsPage === null
      ? {}
      : { classicStandingsPage }),
    source,
    triggeredAt: new Date(now).toISOString(),
  };
  const job = await managerLiveQueue.add(MANAGER_LIVE_JOBS.REFRESH, data, {
    // A Classic standings continuation must not deduplicate against a normal
    // cache-only access job in the same 30-second bucket. The page belongs to
    // the continuation identity so an ordinary request can never discard the
    // cursor needed to converge managers beyond the first bounded page window.
    jobId: managerLiveRefreshJobId(scope, runAt, classicStandingsPage),
    delay: Math.max(0, runAt.getTime() - now),
  });
  logInfo('Manager live refresh job enqueued', {
    queue: managerLiveQueue.name,
    jobId: job.id,
    eventId: scope.eventId,
    tournamentId: scope.tournamentId ?? null,
    source,
  });
  return job;
}

export async function enqueueManagerLiveRefresh(input: {
  season: FplSeasonRef;
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
  runAt?: Date;
  markHot?: boolean;
  source?: ManagerLiveJobData['source'];
}): Promise<Job<ManagerLiveJobData>> {
  const scope: ManagerLiveRefreshScope = {
    seasonId: input.season.seasonId,
    seasonCode: input.season.seasonCode,
    eventId: input.eventId,
    entryIds: normalizeManagerLiveEntryIds(input.entryIds),
    ...(input.tournamentId === undefined ? {} : { tournamentId: input.tournamentId }),
  };
  try {
    if (input.markHot !== false) await markManagerLiveScopeHot(scope);
    return await addManagerLiveRefresh(scope, input.source ?? 'request', input.runAt ?? new Date());
  } catch (error) {
    logError('Failed to enqueue manager live refresh', error, {
      eventId: input.eventId,
      tournamentId: input.tournamentId ?? null,
    });
    throw error;
  }
}

export async function enqueueManagerLiveRefreshBatches(input: {
  season: FplSeasonRef;
  eventId: number;
  entryIds: readonly number[];
  tournamentId?: number;
  runAt?: Date;
  markHot?: boolean;
  source?: ManagerLiveJobData['source'];
}): Promise<Job<ManagerLiveJobData>[]> {
  const runAt = input.runAt ?? new Date();
  const entryChunks = managerLiveDispatchEntryChunks(input.entryIds);
  const jobInput = input;
  return Promise.all(
    entryChunks.map((entryIds) => enqueueManagerLiveRefresh({ ...jobInput, entryIds, runAt })),
  );
}

export async function scheduleNextManagerLiveRefresh(
  jobData: ManagerLiveJobData,
  nextRefreshAt: string,
  classicStandingsNextPage?: number | null,
): Promise<Job<ManagerLiveJobData> | null> {
  const scope: ManagerLiveRefreshScope = {
    seasonId: jobData.seasonId,
    seasonCode: jobData.seasonCode,
    eventId: jobData.eventId,
    entryIds: normalizeManagerLiveEntryIds(jobData.entryIds),
    ...(jobData.tournamentId === undefined ? {} : { tournamentId: jobData.tournamentId }),
  };
  // Do not swallow Redis failures here. Propagating them fails the current
  // worker attempt, allowing BullMQ's configured 30/60/120-second retries to
  // restore the recurring chain once queue Redis recovers.
  const hotScope = await readHotManagerLiveScope(scope);
  if (!hotScope) return null;
  const requestedRunAt = new Date(nextRefreshAt);
  const runAt = Number.isFinite(requestedRunAt.getTime())
    ? new Date(Math.max(Date.now() + 1_000, requestedRunAt.getTime()))
    : new Date(Date.now() + MANAGER_LIVE_REFRESH_BUCKET_MS);
  return addManagerLiveRefresh(hotScope, 'followup', runAt, classicStandingsNextPage);
}
