import { Elysia } from 'elysia';

import { enqueuePlayerValuesSyncJob } from '../jobs/data-sync-enqueue';
import { seasonRepository } from '../repositories/seasons';

/**
 * Player Values API Routes
 *
 * Handles player values operational endpoints:
 * - POST /player-values/sync - Trigger current player values sync (checks today's date for changes)
 *
 * Player values are date-based (changeDate), tracking price changes by date.
 * Each record is uniquely identified by (elementId, changeDate).
 */

export const playerValuesAPI = new Elysia({ prefix: '/player-values' }).post(
  '/sync',
  async ({ set }) => {
    const season = await seasonRepository.findCurrent();
    const job = await enqueuePlayerValuesSyncJob(season, 'api');
    set.status = 202;
    return {
      success: true,
      message: 'Player values sync job enqueued',
      jobId: job.id,
    };
  },
);
