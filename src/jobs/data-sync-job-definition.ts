import { randomUUID } from 'node:crypto';

import type { DataSyncJobName } from '../queues/data-sync.queue';

export type DataSyncJobSource = 'cron' | 'manual' | 'api' | 'event-transition' | 'cascade';

export interface DataSyncEnqueueOptions {
  jobId?: string;
  eventId?: number;
  changeDate?: string;
  season?: string;
  /** When true (default for explicit jobId), remove job on settle so re-triggers work. */
  removeOnSettle?: boolean;
}

export function defaultDataSyncJobId(
  jobName: DataSyncJobName,
  source: DataSyncJobSource,
  options: DataSyncEnqueueOptions,
): string | undefined {
  // API/manual triggers dedupe in the waiting room; cron stays unique per tick.
  if (source !== 'api' && source !== 'manual') {
    return undefined;
  }
  const eventPart = options.eventId !== undefined ? `-e${options.eventId}` : '';
  const datePart = options.changeDate !== undefined ? `-${options.changeDate}` : '';
  const seasonPart = options.season !== undefined ? `-${options.season}` : '';
  return `${jobName}${eventPart}${datePart}${seasonPart}-${source}`;
}

export function createDataSyncJobData(source: DataSyncJobSource, options: DataSyncEnqueueOptions) {
  return {
    source,
    triggeredAt: new Date().toISOString(),
    runId: randomUUID(),
    ...(options.eventId !== undefined ? { eventId: options.eventId } : {}),
    ...(options.changeDate !== undefined ? { changeDate: options.changeDate } : {}),
    ...(options.season !== undefined ? { season: options.season } : {}),
  };
}
