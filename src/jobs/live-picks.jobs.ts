import type { FplSeasonRef } from '../domain/fpl-season';
import {
  resolveLivePicksCoordinatorDeduplicationId,
  runPicksProbeAndSync,
} from '../services/live-lifecycle-orchestrator';
import { livePicksQueue } from '../queues/live-picks.queue';
import { logError, logInfo } from '../utils/logger';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';

export type LivePicksRefreshResult = Readonly<{
  canaryCount: number;
  synced: number;
  pending: number;
  /** The scheduler may settle this root as skipped after an accepted backoff. */
  outcome?: 'accepted-backoff';
  sourceReady: boolean;
  /** The root was durably deferred until the shared bootstrap gate is ready. */
  status?: 'waiting-dependencies';
  sourceReason?: 'BOOTSTRAP_HTTP_NOT_200' | 'BOOTSTRAP_PROBE_UNKNOWN';
  scanComplete: boolean;
  freshnessEvidenceRecorded?: boolean;
}>;

export type LivePicksRefreshJobData = Readonly<{
  seasonId: number;
  seasonCode: string;
  eventId: number;
  triggeredAt: string;
  obligationId?: string;
  obligationGeneration?: number;
  /** Exact freshness window being repaired, carried into the child scan. */
  freshnessWindowId?: number;
  /** Event deadline used only to report remaining round budget. */
  deadlineAt?: string;
}>;

export async function enqueueLivePicksRefresh(
  season: FplSeasonRef,
  eventId: number,
  options: Readonly<{
    jobId?: string;
    obligationId?: string;
    obligationGeneration?: number;
    freshnessWindowId?: number;
    deadlineAt?: Date | null;
    now?: Date;
  }> = {},
) {
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new Error('Live picks refresh requires a positive event id');
  }
  if (await isQueueDrainOnly(livePicksQueue.name)) {
    throw new QueueDrainOnlyError(livePicksQueue.name);
  }
  const now = options.now ?? new Date();
  const job = await livePicksQueue.add(
    'live-picks-refresh',
    {
      seasonId: season.seasonId,
      seasonCode: season.seasonCode,
      eventId,
      triggeredAt: now.toISOString(),
      ...(options.obligationId ? { obligationId: options.obligationId } : {}),
      ...(options.obligationGeneration === undefined
        ? {}
        : { obligationGeneration: options.obligationGeneration }),
      ...(options.freshnessWindowId === undefined
        ? {}
        : { freshnessWindowId: options.freshnessWindowId }),
      ...(options.deadlineAt instanceof Date && Number.isFinite(options.deadlineAt.getTime())
        ? { deadlineAt: options.deadlineAt.toISOString() }
        : {}),
    },
    {
      jobId: options.jobId ?? `live-picks-refresh-${season.seasonCode}-e${eventId}`,
      deduplication: {
        id: resolveLivePicksCoordinatorDeduplicationId(season.seasonCode, eventId),
      },
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
    },
  );
  logInfo('Live picks refresh queued', { queue: livePicksQueue.name, jobId: job.id, eventId });
  return job;
}

export async function runLivePicksRefreshJob(
  job: LivePicksRefreshJobData,
): Promise<LivePicksRefreshResult> {
  try {
    const result = await runPicksProbeAndSync(
      { seasonId: job.seasonId, seasonCode: job.seasonCode },
      job.eventId,
      new Date(),
      {
        obligationId: job.obligationId,
        obligationGeneration: job.obligationGeneration,
        freshnessWindowId: job.freshnessWindowId,
        deadlineAt: job.deadlineAt ? new Date(job.deadlineAt) : undefined,
      },
    );
    if (!result.sourceReady) {
      // The worker owns the scheduler fence. Return a non-terminal result so
      // it can defer the obligation instead of recording a Bull failure for a
      // normal pre-bootstrap wait.
      return { ...result, status: 'waiting-dependencies' as const };
    }
    return result;
  } catch (error) {
    logError('Live picks refresh failed', error, { eventId: job.eventId });
    throw error;
  }
}
