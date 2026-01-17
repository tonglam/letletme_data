import { Elysia } from 'elysia';

import { enqueueEventLivesCacheUpdate, enqueueEventLivesDbSync } from '../jobs/live-data.jobs';

/**
 * Event Lives API Routes
 *
 * Handles event live data sync endpoints:
 * - POST /event-lives/sync/:eventId - Enqueue full DB sync job (triggers cascade)
 * - POST /event-lives/cache/:eventId - Enqueue fast cache-only update job
 *
 * Both endpoints enqueue background jobs and return job IDs for tracking
 */

export const eventLivesAPI = new Elysia({ prefix: '/event-lives' })
  .post('/sync/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    const job = await enqueueEventLivesDbSync(eventId, 'manual');
    return {
      success: true,
      message: `Event live DB sync job enqueued for event ${eventId}`,
      jobId: job.id,
      eventId,
    };
  })
  .post('/cache/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    const job = await enqueueEventLivesCacheUpdate(eventId, 'manual');
    return {
      success: true,
      message: `Event live cache update job enqueued for event ${eventId}`,
      jobId: job.id,
      eventId,
    };
  });
