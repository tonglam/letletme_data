import { Elysia } from 'elysia';

import { enqueueCoreSnapshotJob } from '../jobs/data-sync-enqueue';

/**
 * Players API Routes
 *
 * Handles all player operational endpoints:
 * - POST /players/sync - Trigger players sync
 */

export const playersAPI = new Elysia({ prefix: '/players' }).post('/sync', async ({ set }) => {
  const job = await enqueueCoreSnapshotJob('api');
  set.status = 202;
  return { success: true, message: 'Core snapshot job enqueued', jobId: job.id };
});
