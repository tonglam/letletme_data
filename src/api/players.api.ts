import { Elysia } from 'elysia';

import { enqueuePlayersSyncJob } from '../jobs/data-sync-enqueue';

/**
 * Players API Routes
 *
 * Handles all player operational endpoints:
 * - POST /players/sync - Trigger players sync
 */

export const playersAPI = new Elysia({ prefix: '/players' }).post('/sync', async ({ set }) => {
  const job = await enqueuePlayersSyncJob('api');
  set.status = 202;
  return { success: true, message: 'Players sync job enqueued', jobId: job.id };
});
