import { Elysia, t } from 'elysia';

import { enqueueFixturesSyncJob } from '../jobs/data-sync-enqueue';
import { clearFixturesCache } from '../services/fixtures.service';

/**
 * Fixtures API Routes
 *
 * Handles all fixture-related HTTP endpoints:
 * - POST /fixtures/sync - Enqueue fixtures sync (all or specific event), 202
 * - POST /fixtures/sync-all-gameweeks - Enqueue full backfill of every gameweek, 202
 * - DELETE /fixtures/cache - Clear fixtures cache
 */

export const fixturesAPI = new Elysia({ prefix: '/fixtures' })
  .post(
    '/sync',
    async ({ query, set }) => {
      const job = await enqueueFixturesSyncJob('api', {
        ...(query.event !== undefined ? { eventId: query.event } : {}),
      });
      set.status = 202;
      return {
        success: true,
        message:
          query.event !== undefined
            ? `Fixtures sync job enqueued for event ${query.event}`
            : 'Fixtures sync job enqueued',
        jobId: job.id,
      };
    },
    {
      query: t.Object({ event: t.Optional(t.Number({ minimum: 1, multipleOf: 1 })) }),
    },
  )

  .post('/sync-all-gameweeks', async ({ set }) => {
    // The fixtures job with no event filter syncs every gameweek's fixtures and
    // rebuilds the full fixtures cache — the same end state as the old inline
    // 38-request loop, with queue retries and dedup via a stable jobId.
    const job = await enqueueFixturesSyncJob('api', {
      jobId: 'fixtures-sync-all-gameweeks-api',
    });
    set.status = 202;
    return {
      success: true,
      message: 'Fixtures sync job enqueued for all gameweeks',
      jobId: job.id,
    };
  })

  .delete('/cache', async () => {
    await clearFixturesCache();
    return { success: true, message: 'Fixtures cache cleared' };
  });
