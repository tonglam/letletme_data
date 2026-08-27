import type { FplSeasonRef } from '../domain/fpl-season';
import { runPicksProbeAndSync } from '../services/live-lifecycle-orchestrator';
import { livePicksQueue } from '../queues/live-picks.queue';
import { logError, logInfo } from '../utils/logger';
import { FPLClientError } from '../utils/errors';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';

export type LivePicksRefreshResult = Readonly<{
  canaryCount: number;
  synced: number;
  pending: number;
  sourceReady: boolean;
  scanComplete: boolean;
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
}>;

export async function enqueueLivePicksRefresh(
  season: FplSeasonRef,
  eventId: number,
  options: Readonly<{
    jobId?: string;
    obligationId?: string;
    obligationGeneration?: number;
    freshnessWindowId?: number;
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
    },
    {
      jobId: options.jobId ?? `live-picks-refresh-${season.seasonCode}-e${eventId}`,
      deduplication: { id: `live-picks-refresh:${season.seasonCode}:event-${eventId}` },
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
      },
    );
    if (!result.sourceReady) {
      // A Bull-completed root is not a successful obligation: the source
      // canary was not accepted and no child finalizer can prove coverage.
      // Raising a typed, bounded-retry error keeps the durable obligation
      // pending/failed instead of allowing enqueue recovery to mark it green.
      throw new FPLClientError(
        'Live picks source canary is not ready; eligible sweep remains pending',
        409,
        'SOURCE_NOT_READY',
      );
    }
    return result;
  } catch (error) {
    logError('Live picks refresh failed', error, { eventId: job.eventId });
    throw error;
  }
}
