import { Elysia } from 'elysia';

import { enqueueCoreSnapshotJob } from '../jobs/data-sync-enqueue';
import { seasonRepository } from '../repositories/seasons';

/**
 * Fixtures API Routes
 *
 * Handles all fixture-related HTTP endpoints:
 * - POST /fixtures/sync - Enqueue the complete core snapshot, 202
 * The upstream fixture endpoint is a complete-season feed, so there is one coherent sync route.
 */

export const fixturesAPI = new Elysia({ prefix: '/fixtures' }).post('/sync', async ({ set }) => {
  const season = await seasonRepository.findCurrent();
  const job = await enqueueCoreSnapshotJob(season, 'api');
  set.status = 202;
  return {
    success: true,
    message: 'Core snapshot job enqueued',
    jobId: job.id,
  };
});
