import { Job, QueueEvents, Worker } from 'bullmq';

import { requireCurrentSeasonForJob } from '../domain/season-scoped-job';
import {
  normalizeManagerLiveEntryIds,
  shouldStopManagerLiveRefresh,
  type ManagerLiveHotScopeState,
} from '../domain/manager-live-refresh';
import {
  readHotManagerLiveScope,
  reconcileManagerLiveHotScopeRoster,
  scheduleNextManagerLiveRefresh,
} from '../jobs/manager-live.jobs';
import {
  MANAGER_LIVE_JOBS,
  MANAGER_LIVE_JOB_VERSION,
  managerLiveQueue,
  managerLiveQueueName,
  type ManagerLiveJobData,
} from '../queues/manager-live.queue';
import { eventRepository } from '../repositories/events';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import {
  refreshManagerLiveScores,
  type ManagerLiveResolveResult,
} from '../services/manager-live.service';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { getQueueConnection } from '../utils/queue';
import { isTerminalJobFailure } from '../utils/worker-failure';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import type { WorkerRuntime } from './worker-runtime';

export async function scheduleManagerLiveContinuation(
  jobData: ManagerLiveJobData,
  result: Pick<
    ManagerLiveResolveResult,
    'nextRefreshAt' | 'classicStandingsNextPage' | 'errorCode'
  >,
  classicStandingsStartPage?: number,
  schedule: typeof scheduleNextManagerLiveRefresh = scheduleNextManagerLiveRefresh,
): Promise<void> {
  // Preserve the six-hour hot chain even when one entry in a larger scope
  // fails. The current job still fails below so BullMQ applies 30/60/120s
  // retries, while the deduplicated follow-up keeps healthy managers fresh.
  await schedule(
    jobData,
    result.nextRefreshAt,
    result.classicStandingsNextPage,
    classicStandingsStartPage,
  );
  if (result.errorCode === 'UPSTREAM_RATE_LIMITED' || result.errorCode === 'UPSTREAM_UNAVAILABLE') {
    throw new Error(`Manager live refresh failed: ${result.errorCode}`);
  }
}

export const shouldRetryFinalizedTournamentManagerLive = (
  result: Pick<ManagerLiveResolveResult, 'partial' | 'errorCode'>,
): boolean => result.partial && result.errorCode === 'UPSTREAM_UNAVAILABLE';

/**
 * A failed BullMQ attempt must retry the bounded chunk it actually owned.
 * Follow-up jobs advance the shared hot cursor before the failed attempt is
 * retried, so adopting that cursor on retry would silently skip the failed
 * chunk. A roster-generation rotation is the one exception: the old job no
 * longer owns the authoritative roster and must adopt the new lane's cursors.
 */
export const selectManagerLiveJobCursors = (input: {
  attemptsMade: number;
  jobData: Pick<
    ManagerLiveJobData,
    'generation' | 'summaryRotationCursor' | 'classicStandingsPage' | 'classicStandingsCursorEpoch'
  >;
  hotState: Pick<
    ManagerLiveHotScopeState,
    'generation' | 'summaryRotationCursor' | 'classicStandingsPage' | 'classicStandingsCursorEpoch'
  >;
}) => {
  const rosterGenerationChanged = input.jobData.generation !== input.hotState.generation;
  const pinRetryCursors = input.attemptsMade > 0 && !rosterGenerationChanged;

  return {
    rosterGenerationChanged,
    retryCursorsPinned: pinRetryCursors,
    summaryRotationCursor: pinRetryCursors
      ? (input.jobData.summaryRotationCursor ?? input.hotState.summaryRotationCursor)
      : input.hotState.summaryRotationCursor,
    classicStandingsPage: pinRetryCursors
      ? input.jobData.classicStandingsPage
      : (input.hotState.classicStandingsPage ?? undefined),
    classicStandingsCursorEpoch: pinRetryCursors
      ? (input.jobData.classicStandingsCursorEpoch ?? input.hotState.classicStandingsCursorEpoch)
      : input.hotState.classicStandingsCursorEpoch,
  };
};

export async function processManagerLiveJob(job: Job<ManagerLiveJobData>) {
  if (job.name !== MANAGER_LIVE_JOBS.REFRESH || job.data.version !== MANAGER_LIVE_JOB_VERSION) {
    throw new Error(`Unsupported manager live job: ${job.name}@${job.data.version}`);
  }
  const season = await requireCurrentSeasonForJob(job.data);
  const event = await eventRepository.findById(season, job.data.eventId);
  if (!event) throw new Error(`Manager live event ${job.data.eventId} was not found`);

  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    eventId: job.data.eventId,
    ...(job.data.tournamentId === undefined ? {} : { tournamentId: job.data.tournamentId }),
    source: job.data.source,
    attempt: job.attemptsMade + 1,
  };
  logJobTriggered(context);

  return runTrackedJob(context, async () => {
    const eventFinalized = shouldStopManagerLiveRefresh(event);
    if (eventFinalized && job.data.tournamentId === undefined) {
      logInfo('Manager live refresh stopped after final event settlement', {
        eventId: job.data.eventId,
        tournamentId: job.data.tournamentId ?? null,
      });
      return { stopped: 'event-finalized' as const };
    }

    const authoritativeEntryIds = normalizeManagerLiveEntryIds(
      job.data.tournamentId === undefined
        ? job.data.entryIds
        : await tournamentEntryRepository.findEntryIdsByTournamentId(season, job.data.tournamentId),
    );
    const jobEntryIds = normalizeManagerLiveEntryIds(job.data.entryIds);
    const currentHotState = await readHotManagerLiveScope({
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      eventId: job.data.eventId,
      entryIds: authoritativeEntryIds,
      ...(job.data.tournamentId === undefined ? {} : { tournamentId: job.data.tournamentId }),
    });
    const jobOwnsCurrentRoster =
      currentHotState !== null &&
      currentHotState.entryIds.length === jobEntryIds.length &&
      currentHotState.entryIds.every((entryId, index) => entryId === jobEntryIds[index]);
    if (
      !job.data.generation ||
      !currentHotState ||
      (currentHotState.generation !== job.data.generation && jobOwnsCurrentRoster)
    ) {
      logInfo('Manager live refresh stopped for stale or missing hot generation', {
        eventId: job.data.eventId,
        tournamentId: job.data.tournamentId ?? null,
        generation: job.data.generation ?? null,
      });
      return { stopped: 'stale-hot-generation' as const };
    }
    const hotState = await reconcileManagerLiveHotScopeRoster({
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      eventId: job.data.eventId,
      entryIds: authoritativeEntryIds,
      ...(job.data.tournamentId === undefined ? {} : { tournamentId: job.data.tournamentId }),
    });
    const selectedCursors = selectManagerLiveJobCursors({
      attemptsMade: job.attemptsMade,
      jobData: job.data,
      hotState,
    });
    const effectiveJobData: ManagerLiveJobData = {
      ...job.data,
      entryIds: hotState.entryIds,
      generation: hotState.generation,
      summaryRotationCursor: selectedCursors.summaryRotationCursor,
      classicStandingsPage: selectedCursors.classicStandingsPage,
      classicStandingsCursorEpoch: selectedCursors.classicStandingsCursorEpoch,
    };
    const needsJobDataUpdate =
      effectiveJobData.generation !== job.data.generation ||
      !effectiveJobData.entryIds.every((entryId, index) => entryId === jobEntryIds[index]) ||
      effectiveJobData.entryIds.length !== jobEntryIds.length ||
      effectiveJobData.summaryRotationCursor !== job.data.summaryRotationCursor ||
      effectiveJobData.classicStandingsPage !== job.data.classicStandingsPage ||
      effectiveJobData.classicStandingsCursorEpoch !== job.data.classicStandingsCursorEpoch;
    if (needsJobDataUpdate) {
      // A roster reconciliation rotates the Redis generation. Persist the
      // adopted generation/cursors on the active Bull job before doing any
      // upstream work so a transient failure retries the new lane rather than
      // being discarded as stale.
      await job.updateData(effectiveJobData);
      job.data = effectiveJobData;
    }
    const classicStandingsStartPage = selectedCursors.classicStandingsPage ?? 1;
    // BullMQ retries reuse the same job data, so they retry the same bounded
    // summary chunk. The atomic hot state advances this logical cursor only
    // when the follow-up is scheduled; wall-clock parity cannot starve a
    // permanently failing manager when the event uses 60-second refreshes.
    const summaryRotationCursor =
      Number.isSafeInteger(effectiveJobData.summaryRotationCursor) &&
      (effectiveJobData.summaryRotationCursor ?? -1) >= 0
        ? effectiveJobData.summaryRotationCursor
        : hotState.summaryRotationCursor;
    const result = await refreshManagerLiveScores({
      eventId: effectiveJobData.eventId,
      entryIds: effectiveJobData.entryIds,
      ...(effectiveJobData.tournamentId === undefined
        ? {}
        : { tournamentId: effectiveJobData.tournamentId }),
      ...(classicStandingsStartPage === undefined || classicStandingsStartPage === null
        ? {}
        : { classicStandingsStartPage }),
      summaryRotationCursor,
    });
    if (eventFinalized) {
      // Final rows can become visible one entry at a time after the event is
      // data-checked. Keep a database-only continuation alive until the
      // authoritative result scan is complete; the finalized service branch
      // never calls the current FPL manager endpoints.
      if (
        job.data.tournamentId !== undefined &&
        shouldRetryFinalizedTournamentManagerLive(result)
      ) {
        await scheduleManagerLiveContinuation(effectiveJobData, result, classicStandingsStartPage);
      }
      return result;
    }
    await scheduleManagerLiveContinuation(effectiveJobData, result, classicStandingsStartPage);
    return result;
  });
}

export function createManagerLiveWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<ManagerLiveJobData>(managerLiveQueueName, processManagerLiveJob, {
    connection,
    concurrency: 2,
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(managerLiveQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Manager live worker completed job', {
      jobId: job.id,
      eventId: job.data.eventId,
      tournamentId: job.data.tournamentId ?? null,
    });
  });
  worker.on('failed', (job, error) => {
    logError('Manager live worker failed job', error, {
      jobId: job?.id,
      eventId: job?.data.eventId,
      tournamentId: job?.data.tournamentId ?? null,
    });
    if (job && isTerminalJobFailure(job, error)) void alertOnFinalFailure(job, error);
  });
  worker.on('error', (error) => logError('Manager live worker error', error));

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: managerLiveQueue, queueEvents, queueName: managerLiveQueueName }],
  };
}
