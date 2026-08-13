import type { Elysia } from 'elysia';

import { registerEventCurrentRefreshJobs } from './event-current-refresh.job';
import { registerDataSyncJobs } from './data-sync.jobs';
import { registerPlayerValuesWindowJobs } from './player-values-window.jobs';
import { registerPlayerMarketFreshnessJobs } from './player-market-freshness.jobs';

export function registerDataJobs(app: Elysia) {
  return app
    .use(registerDataSyncJobs)
    .use(registerPlayerValuesWindowJobs)
    .use(registerPlayerMarketFreshnessJobs)
    .use(registerEventCurrentRefreshJobs);
}
