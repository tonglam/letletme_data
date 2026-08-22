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
} as const;

export type MaintenanceJobName = (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS];
export type MaintenanceJobSource = 'schedule' | 'catchup' | 'reconcile' | 'manual';

export type MaintenanceJobData = {
  jobName: MaintenanceJobName;
  source: MaintenanceJobSource;
  seasonId: number;
  seasonCode: string;
  triggeredAt: string;
  runId: string;
  obligationId?: string;
  obligationGeneration?: number;
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
