import { Elysia, t } from 'elysia';

import {
  enqueueFixturesAllGameweeksSyncJob,
  enqueueFixturesSyncJob,
} from '../jobs/data-sync-enqueue';
import { clearFixturesCache } from '../services/fixtures.service';

/**
 * Fixtures API Routes
 *
 * Handles all fixture-related HTTP endpoints:
 * - POST /fixtures/sync - Enqueue fixtures sync (all or specific event), 202
 * - POST /fixtures/sync-all-gameweeks - Enqueue per-GW backfill (isolated errors), 202
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
    // Dedicated job → syncAllGameweeks(): per-GW try/catch so one bad week
    // does not abort the whole 1–38 backfill (unlike syncFixtures(undefined)).
    const job = await enqueueFixturesAllGameweeksSyncJob('api');
    set.status = 202;
    return {
      success: true,
      message: 'Fixtures all-gameweeks backfill job enqueued',
      jobId: job.id,
    };
  })

  .delete('/cache', async () => {
    await clearFixturesCache();
    return { success: true, message: 'Fixtures cache cleared' };
  });
