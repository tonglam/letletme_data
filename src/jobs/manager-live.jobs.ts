import type { Job } from 'bullmq';

import type { FplSeasonRef } from '../domain/fpl-season';
import {
  advanceManagerLiveHotState,
  initializeManagerLiveHotState,
  loadManagerLiveHotState,
  managerLiveDispatchEntryChunks,
  MANAGER_LIVE_REFRESH_BUCKET_MS,
  managerLiveRefreshJobIdForState,
  normalizeManagerLiveEntryIds,
  type ManagerLiveHotScopeState,
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

export async function markManagerLiveScopeHot(
  scope: ManagerLiveRefreshScope,
): Promise<ManagerLiveHotScopeState> {
  const redis = await queueRedisSingleton.getClient();
  return initializeManagerLiveHotState(redis, scope);
}

export async function readHotManagerLiveScope(
  scope: ManagerLiveRefreshScope,
): Promise<ManagerLiveHotScopeState | null> {
  const redis = await queueRedisSingleton.getClient();
  return loadManagerLiveHotState(redis, scope);
}

const managerLiveScopeFromJobData = (jobData: ManagerLiveJobData): ManagerLiveRefreshScope => ({
  seasonId: jobData.seasonId,
  seasonCode: jobData.seasonCode,
  eventId: jobData.eventId,
  entryIds: normalizeManagerLiveEntryIds(jobData.entryIds),
  ...(jobData.tournamentId === undefined ? {} : { tournamentId: jobData.tournamentId }),
});

export async function readManagerLiveClassicCursor(
  jobData: ManagerLiveJobData,
): Promise<number | null | undefined> {
  const state = await readHotManagerLiveScope(managerLiveScopeFromJobData(jobData));
  if (!state || !jobData.generation || state.generation !== jobData.generation) return undefined;
  return state.classicStandingsPage;
}

export async function readManagerLiveHotState(
  jobData: ManagerLiveJobData,
): Promise<ManagerLiveHotScopeState | null> {
  const state = await readHotManagerLiveScope(managerLiveScopeFromJobData(jobData));
  if (!state || !jobData.generation || state.generation !== jobData.generation) return null;
  return state;
}

async function addManagerLiveRefresh(
  scope: ManagerLiveRefreshScope,
  source: ManagerLiveJobData['source'],
  runAt: Date,
  hotState?: ManagerLiveHotScopeState | null,
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
    ...(hotState?.generation === undefined ? {} : { generation: hotState.generation }),
    ...(hotState?.summaryRotationCursor === undefined
      ? {}
      : { summaryRotationCursor: hotState.summaryRotationCursor }),
    ...(hotState?.classicStandingsCursorEpoch === undefined
      ? {}
      : { classicStandingsCursorEpoch: hotState.classicStandingsCursorEpoch }),
    ...(classicStandingsPage === undefined || classicStandingsPage === null
      ? hotState?.classicStandingsPage === null || hotState?.classicStandingsPage === undefined
        ? {}
        : { classicStandingsPage: hotState.classicStandingsPage }
      : { classicStandingsPage }),
    source,
    triggeredAt: new Date(now).toISOString(),
  };
  const job = await managerLiveQueue.add(MANAGER_LIVE_JOBS.REFRESH, data, {
    // One generation owns one refresh lane per 30-second bucket. The logical
    // summary and Classic cursors live in the same Redis state, so a restarted
    // hot scope cannot be mutated by an older queued job.
    jobId: hotState
      ? managerLiveRefreshJobIdForState(scope, runAt, hotState.generation)
      : `manager-live-legacy-${scope.seasonCode}-e${scope.eventId}-${runAt.getTime()}`,
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
    const hotState =
      input.markHot === false
        ? await readHotManagerLiveScope(scope)
        : await markManagerLiveScopeHot(scope);
    return await addManagerLiveRefresh(
      scope,
      input.source ?? 'request',
      input.runAt ?? new Date(),
      hotState,
    );
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
  classicStandingsStartPage?: number,
): Promise<Job<ManagerLiveJobData> | null> {
  const scope = managerLiveScopeFromJobData(jobData);
  // Do not swallow Redis failures here. Propagating them fails the current
  // worker attempt, allowing BullMQ's configured 30/60/120-second retries to
  // restore the recurring chain once queue Redis recovers.
  const hotScope = await readHotManagerLiveScope(scope);
  if (!hotScope) return null;
  // A pre-v2 job has no generation and is not allowed to mutate continuation
  // state after a hot-scope restart.
  if (!jobData.generation || jobData.generation !== hotScope.generation) return null;
  const redis = await queueRedisSingleton.getClient();
  const updatedState = await advanceManagerLiveHotState(
    redis,
    scope,
    hotScope.generation,
    jobData.summaryRotationCursor ?? hotScope.summaryRotationCursor,
    classicStandingsNextPage,
    // Compare-and-set against the page this worker actually fetched. Reading
    // the current hot cursor here would let a slow page-one job mistake a
    // later page (advanced by faster jobs) for its own starting page.
    classicStandingsStartPage ?? jobData.classicStandingsPage ?? 1,
    Number.isSafeInteger(jobData.classicStandingsCursorEpoch) &&
      (jobData.classicStandingsCursorEpoch ?? -1) >= 0
      ? jobData.classicStandingsCursorEpoch
      : 0,
  );
  if (!updatedState) return null;
  const requestedRunAt = new Date(nextRefreshAt);
  const runAt = Number.isFinite(requestedRunAt.getTime())
    ? new Date(Math.max(Date.now() + 1_000, requestedRunAt.getTime()))
    : new Date(Date.now() + MANAGER_LIVE_REFRESH_BUCKET_MS);
  return addManagerLiveRefresh(updatedState, 'followup', runAt, updatedState);
}
