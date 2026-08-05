import { Elysia, t } from 'elysia';

import { enqueueCoreSnapshotJob } from '../jobs/data-sync-enqueue';
import { clearFixturesCache } from '../services/fixtures.service';

/**
 * Fixtures API Routes
 *
 * Handles all fixture-related HTTP endpoints:
 * - POST /fixtures/sync - Enqueue the complete core snapshot, 202
 * - POST /fixtures/sync-all-gameweeks - Compatibility alias for the same snapshot, 202
 * - DELETE /fixtures/cache - Clear fixtures cache
 */

export const fixturesAPI = new Elysia({ prefix: '/fixtures' })
  .post(
    '/sync',
    async ({ query, set }) => {
      const job =
        query.event === undefined
          ? await enqueueCoreSnapshotJob('api')
          : await enqueueCoreSnapshotJob('api', { eventId: query.event });
      set.status = 202;
      return {
        success: true,
        message:
          query.event !== undefined
            ? `Core snapshot job enqueued for fixture event ${query.event}`
            : 'Core snapshot job enqueued',
        jobId: job.id,
      };
    },
    {
      query: t.Object({ event: t.Optional(t.Number({ minimum: 1, multipleOf: 1 })) }),
    },
  )

  .post('/sync-all-gameweeks', async ({ set }) => {
    const job = await enqueueCoreSnapshotJob('api');
    set.status = 202;
    return {
      success: true,
      message: 'Core snapshot job enqueued',
      jobId: job.id,
    };
  })

  .delete('/cache', async () => {
    await clearFixturesCache();
    return { success: true, message: 'Fixtures cache cleared' };
  });
