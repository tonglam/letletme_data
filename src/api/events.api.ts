import { Elysia } from 'elysia';

import { enqueueEventsSyncJob } from '../jobs/data-sync-enqueue';
import { getCurrentEvent, getNextEvent } from '../services/events.service';

export const eventsAPI = new Elysia({ prefix: '/events' })
  .get('/current', async () => {
    const data = await getCurrentEvent();
    return { success: true, data };
  })
  .get('/next', async () => {
    const data = await getNextEvent();
    return { success: true, data };
  })
  .post('/sync', async ({ set }) => {
    const job = await enqueueEventsSyncJob('api');
    set.status = 202;
    return { success: true, message: 'Events sync job enqueued', jobId: job.id };
  });
