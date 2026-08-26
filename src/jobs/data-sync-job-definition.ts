import { randomUUID } from 'node:crypto';

import type { DataSyncJobName } from '../queues/data-sync.queue';
import type { FplSeasonRef } from '../domain/fpl-season';

export type DataSyncJobSource =
  | 'cron'
  | 'manual'
  | 'api'
  | 'event-transition'
  | 'cascade'
  | 'catchup'
  | 'reconcile';

export interface DataSyncEnqueueOptions {
  jobId?: string;
  /** Correlates all refresh inputs for one My FPL coordinator attempt. */
  runId?: string;
  eventId?: number;
  changeDate?: string;
  obligationId?: string;
  obligationGeneration?: number;
  laneId?: string;
  laneGeneration?: number;
  blockerLaneId?: string;
  /** Exact freshness window being repaired, when this is a governance retry. */
  freshnessWindowId?: number;
  /** When true (default for explicit jobId), remove job on settle so re-triggers work. */
  removeOnSettle?: boolean;
}

export function getExplicitDataSyncQueueJobId(season: FplSeasonRef, jobId: string): string {
  return `${season.seasonCode}-${jobId}`;
}

export function defaultDataSyncJobId(
  jobName: DataSyncJobName,
  season: FplSeasonRef,
  source: DataSyncJobSource,
  options: DataSyncEnqueueOptions,
): string | undefined {
  // API/manual triggers dedupe in the waiting room; cron stays unique per tick.
  if (source !== 'api' && source !== 'manual') {
    return undefined;
  }
  const eventPart = options.eventId !== undefined ? `-e${options.eventId}` : '';
  const datePart = options.changeDate !== undefined ? `-${options.changeDate}` : '';
  return `${jobName}-${season.seasonCode}${eventPart}${datePart}-${source}`;
}

export function createDataSyncJobData(
  season: FplSeasonRef,
  source: DataSyncJobSource,
  options: DataSyncEnqueueOptions,
) {
  const runId =
    options.runId ??
    (options.obligationId && (options.obligationGeneration ?? 0) === 0
      ? options.obligationId
      : randomUUID());
  return {
    seasonId: season.seasonId,
    seasonCode: season.seasonCode,
    source,
    triggeredAt: new Date().toISOString(),
    // Scheduler-owned jobs use the durable obligation as their run
    // correlation. This is the identity written to scheduler_obligations and
    // later carried into the publication source_run_id, so freshness evidence
    // can join the exact obligation without guessing from scope/period.
    runId,
    ...(options.obligationId ? { obligationId: options.obligationId } : {}),
    ...(options.obligationGeneration === undefined
      ? {}
      : { obligationGeneration: options.obligationGeneration }),
    ...(options.laneId ? { laneId: options.laneId } : {}),
    ...(options.laneGeneration === undefined ? {} : { laneGeneration: options.laneGeneration }),
    ...(options.blockerLaneId ? { blockerLaneId: options.blockerLaneId } : {}),
    ...(options.eventId !== undefined ? { eventId: options.eventId } : {}),
    ...(options.changeDate !== undefined ? { changeDate: options.changeDate } : {}),
    ...(options.freshnessWindowId === undefined
      ? {}
      : { freshnessWindowId: options.freshnessWindowId }),
  };
}
