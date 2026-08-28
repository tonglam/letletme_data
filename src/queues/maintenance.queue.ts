import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';
import {
  dataRepairQueueName,
  entryOnboardingQueueName,
  housekeepingQueueName,
  myFplOrchestrationQueueName,
  publicationOutboxQueueName,
  maintenanceQueueName,
} from './names';

export type MaintenanceLane =
  | 'maintenance'
  | 'my-fpl-orchestration'
  | 'publication-outbox'
  | 'entry-onboarding'
  | 'data-repair'
  | 'housekeeping';

export const MAINTENANCE_LANE_QUEUE_NAMES = {
  maintenance: maintenanceQueueName,
  'my-fpl-orchestration': myFplOrchestrationQueueName,
  'publication-outbox': publicationOutboxQueueName,
  'entry-onboarding': entryOnboardingQueueName,
  'data-repair': dataRepairQueueName,
  housekeeping: housekeepingQueueName,
} as const satisfies Record<MaintenanceLane, string>;

export const MAINTENANCE_JOBS = {
  PLAYER_MARKET_FRESHNESS: 'player-market-freshness-watchdog',
  PLAYER_SEASON_SUMMARY: 'player-season-summary-repair',
  TOURNAMENT_TRENDS: 'tournament-trends-repair',
  BUG_REPORT_CLEANUP: 'bug-report-cleanup',
  BUG_REPORT_SCREENSHOT_RETENTION: 'bug-report-screenshot-retention',
  CLIENT_SIGNAL_RETENTION: 'client-signal-retention',
  LAUNCH_MONITOR: 'launch-monitor',
  POST_MATCH_CONSOLIDATION: 'post-match-consolidation',
  ENTRY_ONBOARDING: 'entry-onboarding',
  MY_FPL_SNAPSHOT: 'my-fpl-snapshot',
  MY_FPL_SNAPSHOT_OUTBOX: 'my-fpl-snapshot-outbox',
  DATA_PUBLICATION_OUTBOX: 'data-publication-outbox',
  UNDERSTAT_ORPHAN_RECONCILER: 'understat-orphan-reconciler',
} as const;

export type MaintenanceJobName = (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS];
export type MaintenanceJobSource = 'schedule' | 'catchup' | 'reconcile' | 'manual' | 'cron' | 'api';

export type MaintenanceJobData = {
  jobName: MaintenanceJobName;
  /** New lane routing; missing on old jobs and therefore defaults to legacy maintenance. */
  lane?: MaintenanceLane;
  source: MaintenanceJobSource;
  seasonId: number;
  seasonCode: string;
  triggeredAt: string;
  runId: string;
  obligationId?: string;
  obligationGeneration?: number;
  /** Exact freshness window being repaired, carried into a downstream publication. */
  freshnessWindowId?: number;
  /** Actual standalone market-daily Bull identity observed by the watchdog. */
  playerValuesBullJobId?: string;
  entryId?: number;
  eventId?: number;
  snapshotKind?: 'PROVISIONAL' | 'FINAL';
  snapshotActor?: string;
  snapshotReason?: string;
  snapshotIdempotencyKey?: string;
  /** Stable source checkpoint shared by all My FPL child refreshes. */
  freshAfter?: string;
};

export { maintenanceQueueName } from './names';

export const maintenanceQueue = new Queue<MaintenanceJobData>(maintenanceQueueName, {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
  },
});

/** One Bull queue per maintenance lane; the legacy queue remains drain-only. */
export const maintenanceLaneQueues = Object.fromEntries(
  (Object.entries(MAINTENANCE_LANE_QUEUE_NAMES) as [MaintenanceLane, string][]).map(
    ([lane, queueName]) => [
      lane,
      lane === 'maintenance'
        ? maintenanceQueue
        : new Queue<MaintenanceJobData>(queueName, {
            connection: getQueueConnection(),
            defaultJobOptions: {
              attempts: 3,
              backoff: { type: 'exponential', delay: 60_000 },
              removeOnComplete: BULL_COMPLETED_RETENTION,
              removeOnFail: BULL_FAILED_RETENTION,
            },
          }),
    ],
  ),
) as Record<MaintenanceLane, Queue<MaintenanceJobData>>;

export function queueForMaintenanceLane(lane: MaintenanceLane): Queue<MaintenanceJobData> {
  return maintenanceLaneQueues[lane] ?? maintenanceQueue;
}

export async function closeMaintenanceQueue(): Promise<void> {
  await Promise.all(
    Object.values(maintenanceLaneQueues).map((queue) =>
      queue === maintenanceQueue ? Promise.resolve() : queue.close(),
    ),
  );
  await maintenanceQueue.close();
}
