import { Elysia } from 'elysia';

import {
  enqueueEventLiveSummary,
  enqueueEventLivesCacheUpdate,
  enqueueEventLivesDbSync,
} from '../jobs/live-data.jobs';
import { getEventLivesByEventId } from '../services/event-lives.service';

export const eventLivesAPI = new Elysia({ prefix: '/event-lives' })
  .get('/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }
    const data = await getEventLivesByEventId(eventId);
    return { success: true, data, eventId };
  })
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
  })
  .post('/summary/:eventId', async ({ params, set }) => {
    const eventId = parseInt(params.eventId);
    if (isNaN(eventId)) {
      set.status = 400;
      return { success: false, error: 'Invalid event ID' };
    }

    const job = await enqueueEventLiveSummary(eventId, 'manual');
    return {
      success: true,
      message: `Event live summary job enqueued for event ${eventId}`,
      jobId: job.id,
      eventId,
    };
  });
