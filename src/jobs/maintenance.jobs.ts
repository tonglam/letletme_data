import { randomUUID } from 'node:crypto';

import type { FplSeasonRef } from '../domain/fpl-season';
import {
  MAINTENANCE_JOBS,
  queueForMaintenanceLane,
  type MaintenanceLane,
  type MaintenanceJobData,
  type MaintenanceJobName,
  type MaintenanceJobSource,
} from '../queues/maintenance.queue';
import { logError, logInfo } from '../utils/logger';
import { getConfig } from '../utils/config';
import { isQueueDrainOnly, QueueDrainOnlyError } from '../services/queue-governance.service';

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
  /** Shared source checkpoint for a coordinated post-match refresh. */
  freshAfter?: string;
  attempts?: number;
  backoffDelayMs?: number;
  deduplicationId?: string;
  lane?: Exclude<MaintenanceLane, 'maintenance'>;
}>;

/** Exhaustive routing map: adding a maintenance job requires choosing a lane. */
export const MAINTENANCE_JOB_LANES = {
  [MAINTENANCE_JOBS.PLAYER_MARKET_FRESHNESS]: 'data-repair',
  [MAINTENANCE_JOBS.PLAYER_SEASON_SUMMARY]: 'data-repair',
  [MAINTENANCE_JOBS.TOURNAMENT_TRENDS]: 'data-repair',
  [MAINTENANCE_JOBS.BUG_REPORT_CLEANUP]: 'housekeeping',
  [MAINTENANCE_JOBS.BUG_REPORT_SCREENSHOT_RETENTION]: 'housekeeping',
  [MAINTENANCE_JOBS.LAUNCH_MONITOR]: 'housekeeping',
  [MAINTENANCE_JOBS.POST_MATCH_CONSOLIDATION]: 'my-fpl-orchestration',
  [MAINTENANCE_JOBS.ENTRY_ONBOARDING]: 'entry-onboarding',
  [MAINTENANCE_JOBS.MY_FPL_SNAPSHOT]: 'my-fpl-orchestration',
  [MAINTENANCE_JOBS.MY_FPL_SNAPSHOT_OUTBOX]: 'publication-outbox',
  [MAINTENANCE_JOBS.DATA_PUBLICATION_OUTBOX]: 'publication-outbox',
  [MAINTENANCE_JOBS.UNDERSTAT_ORPHAN_RECONCILER]: 'data-repair',
} as const satisfies Record<MaintenanceJobName, Exclude<MaintenanceLane, 'maintenance'>>;

export function maintenanceLaneForJob(
  jobName: MaintenanceJobName,
  options?: Pick<MaintenanceEnqueueOptions, 'lane'>,
): MaintenanceLane {
  if (!getConfig().QUEUE_LANES_V2_ENABLED) return 'maintenance';
  const expectedLane = MAINTENANCE_JOB_LANES[jobName];
  if (options?.lane && options.lane !== expectedLane) {
    throw new Error(
      `Maintenance job ${jobName} must stay on lane ${expectedLane}; received ${options.lane}`,
    );
  }
  return options?.lane ?? expectedLane;
}

export async function enqueueMaintenanceJob(
  season: FplSeasonRef,
  jobName: MaintenanceJobName,
  source: MaintenanceJobSource,
  options: MaintenanceEnqueueOptions = {},
) {
  const runId = options.runId ?? randomUUID();
  const lane = maintenanceLaneForJob(jobName, options);
  if (
    (source === 'manual' || source === 'api') &&
    lane !== 'maintenance' &&
    (await isQueueDrainOnly(lane))
  ) {
    throw new QueueDrainOnlyError(lane);
  }
  const data: MaintenanceJobData = {
    jobName,
    ...(lane === 'maintenance' ? {} : { lane }),
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
    ...(options.freshAfter === undefined ? {} : { freshAfter: options.freshAfter }),
  };
  try {
    const queue = queueForMaintenanceLane(lane);
    const job = await queue.add(jobName, data, {
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
      queue: queue.name,
      lane,
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
