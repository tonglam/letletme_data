import { Elysia } from 'elysia';

import { enqueueCoreSnapshotJob } from '../jobs/data-sync-enqueue';
import { seasonRepository } from '../repositories/seasons';
import { getCurrentEvent, getNextEvent } from '../services/events.service';

export const eventsAPI = new Elysia({ prefix: '/events' })
  .get('/current', async () => {
    const season = await seasonRepository.findCurrent();
    const data = await getCurrentEvent(season);
    return { success: true, data };
  })
  .get('/next', async () => {
    const season = await seasonRepository.findCurrent();
    const data = await getNextEvent(season);
    return { success: true, data };
  })
  .post('/sync', async ({ set }) => {
    const season = await seasonRepository.findCurrent();
    const job = await enqueueCoreSnapshotJob(season, 'api');
    set.status = 202;
    return { success: true, message: 'Core snapshot job enqueued', jobId: job.id };
  });
