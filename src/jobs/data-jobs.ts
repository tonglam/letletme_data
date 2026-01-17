import type { Elysia } from 'elysia';

import { registerDataSyncJobs } from './data-sync.jobs';
import { registerPlayerValuesWindowJobs } from './player-values-window.jobs';

export function registerDataJobs(app: Elysia) {
  return app.use(registerDataSyncJobs).use(registerPlayerValuesWindowJobs);
}
