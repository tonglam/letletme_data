import { Elysia, t } from 'elysia';

import { enqueuePlayerStatsSyncJob } from '../jobs/data-sync-enqueue';

/**
 * Player Stats API Routes
 *
 * Handles player stats operational endpoints:
 * - POST /player-stats/sync - Enqueue current player stats sync, 202
 * - POST /player-stats/sync/:eventId - Enqueue player stats sync for specific event, 202
 */

/** Positive integer path/query param (rejects decimals like 1.5). */
const positiveEventId = t.Number({ minimum: 1, multipleOf: 1 });

export const playerStatsAPI = new Elysia({ prefix: '/player-stats' })
  .post('/sync', async ({ set }) => {
    const job = await enqueuePlayerStatsSyncJob('api');
    set.status = 202;
    return { success: true, message: 'Player stats sync job enqueued', jobId: job.id };
  })

  .post(
    '/sync/:eventId',
    async ({ params, set }) => {
      const job = await enqueuePlayerStatsSyncJob('api', { eventId: params.eventId });
      set.status = 202;
      return {
        success: true,
        message: `Player stats sync job enqueued for event ${params.eventId}`,
        jobId: job.id,
      };
    },
    {
      params: t.Object({ eventId: positiveEventId }),
    },
  );
