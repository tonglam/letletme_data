import { randomUUID } from 'node:crypto';

import type { FplSeasonRef } from '../domain/fpl-season';
import {
  MAINTENANCE_JOBS,
  maintenanceQueue,
  type MaintenanceJobData,
  type MaintenanceJobName,
  type MaintenanceJobSource,
} from '../queues/maintenance.queue';
import { maintenanceQueueName } from '../queues/names';
import { logError, logInfo } from '../utils/logger';

export type MaintenanceEnqueueOptions = Readonly<{
  jobId?: string;
  runId?: string;
  obligationId?: string;
  obligationGeneration?: number;
  entryId?: number;
  eventId?: number;
  snapshotKind?: 'PROVISIONAL' | 'FINAL';
  snapshotActor?: string;
  snapshotReason?: string;
  snapshotIdempotencyKey?: string;
  attempts?: number;
  backoffDelayMs?: number;
  deduplicationId?: string;
}>;

export async function enqueueMaintenanceJob(
  season: FplSeasonRef,
  jobName: MaintenanceJobName,
  source: MaintenanceJobSource,
  options: MaintenanceEnqueueOptions = {},
) {
  const runId = options.runId ?? randomUUID();
  const data: MaintenanceJobData = {
    jobName,
    source,
    seasonId: season.seasonId,
    seasonCode: season.seasonCode,
    triggeredAt: new Date().toISOString(),
    runId,
    ...(options.obligationId ? { obligationId: options.obligationId } : {}),
    ...(options.obligationGeneration === undefined
      ? {}
      : { obligationGeneration: options.obligationGeneration }),
    ...(options.entryId === undefined ? {} : { entryId: options.entryId }),
    ...(options.eventId === undefined ? {} : { eventId: options.eventId }),
    ...(options.snapshotKind === undefined ? {} : { snapshotKind: options.snapshotKind }),
    ...(options.snapshotActor === undefined ? {} : { snapshotActor: options.snapshotActor }),
    ...(options.snapshotReason === undefined ? {} : { snapshotReason: options.snapshotReason }),
    ...(options.snapshotIdempotencyKey === undefined
      ? {}
      : { snapshotIdempotencyKey: options.snapshotIdempotencyKey }),
  };
  try {
    const job = await maintenanceQueue.add(jobName, data, {
      jobId: options.jobId,
      ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
      ...(options.backoffDelayMs === undefined
        ? {}
        : { backoff: { type: 'fixed' as const, delay: options.backoffDelayMs } }),
      ...(options.deduplicationId === undefined
        ? {}
        : { deduplication: { id: options.deduplicationId } }),
      ...(source === 'manual' ? { removeOnComplete: true, removeOnFail: true } : {}),
    });
    logInfo('Maintenance job enqueued', {
      queue: maintenanceQueueName,
      jobId: job.id,
      jobName,
      source,
      runId: job.data.runId,
    });
    return job;
  } catch (error) {
    logError('Failed to enqueue maintenance job', error, { jobName, source });
    throw error;
  }
}

export const enqueuePlayerMarketFreshness = (
  season: FplSeasonRef,
  source: MaintenanceJobSource,
  options?: MaintenanceEnqueueOptions,
) => enqueueMaintenanceJob(season, MAINTENANCE_JOBS.PLAYER_MARKET_FRESHNESS, source, options);

export const enqueuePlayerSeasonSummaryRepair = (
  season: FplSeasonRef,
  source: MaintenanceJobSource,
  options?: MaintenanceEnqueueOptions,
) => enqueueMaintenanceJob(season, MAINTENANCE_JOBS.PLAYER_SEASON_SUMMARY, source, options);

export const enqueueTournamentTrendsRepair = (
  season: FplSeasonRef,
  source: MaintenanceJobSource,
  options?: MaintenanceEnqueueOptions,
) => enqueueMaintenanceJob(season, MAINTENANCE_JOBS.TOURNAMENT_TRENDS, source, options);

export const enqueueBugReportCleanup = (
  season: FplSeasonRef,
  source: MaintenanceJobSource,
  options?: MaintenanceEnqueueOptions,
) => enqueueMaintenanceJob(season, MAINTENANCE_JOBS.BUG_REPORT_CLEANUP, source, options);

export const enqueueBugReportScreenshotRetention = (
  season: FplSeasonRef,
  source: MaintenanceJobSource,
  options?: MaintenanceEnqueueOptions,
) =>
  enqueueMaintenanceJob(season, MAINTENANCE_JOBS.BUG_REPORT_SCREENSHOT_RETENTION, source, options);

export const enqueueLaunchMonitor = (
  season: FplSeasonRef,
  source: MaintenanceJobSource,
  options?: MaintenanceEnqueueOptions,
) => enqueueMaintenanceJob(season, MAINTENANCE_JOBS.LAUNCH_MONITOR, source, options);

export const enqueuePostMatchConsolidation = (
  season: FplSeasonRef,
  source: MaintenanceJobSource,
  options?: MaintenanceEnqueueOptions,
) => enqueueMaintenanceJob(season, MAINTENANCE_JOBS.POST_MATCH_CONSOLIDATION, source, options);

export const enqueueEntryOnboarding = (
  season: FplSeasonRef,
  source: Extract<MaintenanceJobSource, 'api'>,
  options: MaintenanceEnqueueOptions & { entryId: number },
) => {
  const runId = options.runId ?? randomUUID();
  const eventScope = options.eventId ?? 'preseason';
  return enqueueMaintenanceJob(season, MAINTENANCE_JOBS.ENTRY_ONBOARDING, source, {
    ...options,
    runId,
    jobId:
      options.jobId ??
      `entry-onboarding-${season.seasonCode}-e${eventScope}-entry-${options.entryId}-run-${runId}`,
    deduplicationId:
      options.deduplicationId ??
      `entry-onboarding-${season.seasonCode}-e${eventScope}-entry-${options.entryId}`,
  });
};

export const enqueueMyFplSnapshot = (
  season: FplSeasonRef,
  source: MaintenanceJobSource,
  options: MaintenanceEnqueueOptions & {
    eventId: number;
    snapshotKind: 'PROVISIONAL' | 'FINAL';
  },
) =>
  enqueueMaintenanceJob(season, MAINTENANCE_JOBS.MY_FPL_SNAPSHOT, source, {
    ...options,
    attempts: options.attempts ?? 8,
    backoffDelayMs: options.backoffDelayMs ?? 30 * 60_000,
  });

export const enqueueMyFplSnapshotOutbox = (
  season: FplSeasonRef,
  source: MaintenanceJobSource,
  options?: MaintenanceEnqueueOptions,
) => enqueueMaintenanceJob(season, MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX, source, options);
