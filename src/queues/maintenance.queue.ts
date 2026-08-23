import { Queue } from 'bullmq';

import { getQueueConnection } from '../utils/queue';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from './retention';
import { maintenanceQueueName } from './names';

export const MAINTENANCE_JOBS = {
  PLAYER_MARKET_FRESHNESS: 'player-market-freshness-watchdog',
  PLAYER_SEASON_SUMMARY: 'player-season-summary-repair',
  TOURNAMENT_TRENDS: 'tournament-trends-repair',
  BUG_REPORT_CLEANUP: 'bug-report-cleanup',
  BUG_REPORT_SCREENSHOT_RETENTION: 'bug-report-screenshot-retention',
  LAUNCH_MONITOR: 'launch-monitor',
  POST_MATCH_CONSOLIDATION: 'post-match-consolidation',
  ENTRY_ONBOARDING: 'entry-onboarding',
  MY_FPL_SNAPSHOT: 'my-fpl-snapshot',
  MY_FPL_SNAPSHOT_OUTBOX: 'my-fpl-snapshot-outbox',
  UNDERSTAT_ORPHAN_RECONCILER: 'understat-orphan-reconciler',
} as const;

export type MaintenanceJobName = (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS];
export type MaintenanceJobSource = 'schedule' | 'catchup' | 'reconcile' | 'manual' | 'cron' | 'api';

export type MaintenanceJobData = {
  jobName: MaintenanceJobName;
  source: MaintenanceJobSource;
  seasonId: number;
  seasonCode: string;
  triggeredAt: string;
  runId: string;
  obligationId?: string;
  obligationGeneration?: number;
  entryId?: number;
  eventId?: number;
  snapshotKind?: 'PROVISIONAL' | 'FINAL';
  snapshotActor?: string;
  snapshotReason?: string;
  snapshotIdempotencyKey?: string;
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

export async function closeMaintenanceQueue(): Promise<void> {
  await maintenanceQueue.close();
}
