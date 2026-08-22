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
  eventId?: number;
  changeDate?: string;
  obligationId?: string;
  obligationGeneration?: number;
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
  return {
    seasonId: season.seasonId,
    seasonCode: season.seasonCode,
    source,
    triggeredAt: new Date().toISOString(),
    runId: randomUUID(),
    ...(options.obligationId ? { obligationId: options.obligationId } : {}),
    ...(options.obligationGeneration === undefined
      ? {}
      : { obligationGeneration: options.obligationGeneration }),
    ...(options.eventId !== undefined ? { eventId: options.eventId } : {}),
    ...(options.changeDate !== undefined ? { changeDate: options.changeDate } : {}),
  };
}
