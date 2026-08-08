import { Elysia } from 'elysia';

import { enqueueCoreSnapshotJob } from '../jobs/data-sync-enqueue';
import { seasonRepository } from '../repositories/seasons';

/**
 * Players API Routes
 *
 * Handles all player operational endpoints:
 * - POST /players/sync - Trigger players sync
 */

export const playersAPI = new Elysia({ prefix: '/players' }).post('/sync', async ({ set }) => {
  const season = await seasonRepository.findCurrent();
  const job = await enqueueCoreSnapshotJob(season, 'api');
  set.status = 202;
  return { success: true, message: 'Core snapshot job enqueued', jobId: job.id };
});
