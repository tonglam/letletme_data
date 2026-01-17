import type { Elysia } from 'elysia';

import { registerEntryInfoJobs } from './entry-info.jobs';
import { registerEntryPicksJobs } from './entry-picks.jobs';
import { registerEntryTransfersJobs } from './entry-transfers.jobs';
import { registerEntryResultsJobs } from './entry-results.jobs';

/**
 * Register all entry-related cron jobs in one place to keep index.ts lean
 * and ensure the jobs share a consistent initialization order.
 */
export function registerEntryJobs(app: Elysia) {
  return app
    .use(registerEntryInfoJobs)
    .use(registerEntryPicksJobs)
    .use(registerEntryTransfersJobs)
    .use(registerEntryResultsJobs);
}
