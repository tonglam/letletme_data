import type { Elysia } from 'elysia';

import { registerEventCurrentRefreshJobs } from './event-current-refresh.job';
import { registerDataSyncJobs } from './data-sync.jobs';
import { registerPlayerValuesWindowJobs } from './player-values-window.jobs';

export function registerDataJobs(app: Elysia) {
  return app
    .use(registerDataSyncJobs)
    .use(registerPlayerValuesWindowJobs)
    .use(registerEventCurrentRefreshJobs);
}
