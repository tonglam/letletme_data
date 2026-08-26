import type { Elysia } from 'elysia';

import { registerEventCurrentRefreshJobs } from './event-current-refresh.job';
import { registerDataSyncJobs } from './data-sync.jobs';
import { registerPlayerValuesWindowJobs } from './player-values-window.jobs';
import { registerPlayerMarketFreshnessJobs } from './player-market-freshness.jobs';
import { registerPlayerSeasonSummaryJobs } from './player-season-summary.jobs';
import { registerTournamentTrendsRepairJobs } from './tournament-trends-repair.jobs';
import { registerBugReportCleanupJobs } from './bug-report-cleanup.jobs';
import { registerBugReportScreenshotRetentionJobs } from './bug-report-screenshot-retention.jobs';
import { registerClientSignalRetentionJobs } from './client-signal-retention.jobs';

export function registerDataJobs(app: Elysia) {
  return app
    .use(registerDataSyncJobs)
    .use(registerPlayerValuesWindowJobs)
    .use(registerPlayerMarketFreshnessJobs)
    .use(registerPlayerSeasonSummaryJobs)
    .use(registerEventCurrentRefreshJobs)
    .use(registerTournamentTrendsRepairJobs)
    .use(registerBugReportCleanupJobs)
    .use(registerBugReportScreenshotRetentionJobs)
    .use(registerClientSignalRetentionJobs);
}
