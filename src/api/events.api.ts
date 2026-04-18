import { Elysia } from 'elysia';

import { getCurrentEvent, getNextEvent, syncEvents } from '../services/events.service';

export const eventsAPI = new Elysia({ prefix: '/events' })
  .get('/current', async () => {
    const data = await getCurrentEvent();
    return { success: true, data };
  })
  .get('/next', async () => {
    const data = await getNextEvent();
    return { success: true, data };
  })
  .post('/sync', async () => {
    const result = await syncEvents();
    return { success: true, message: 'Events sync completed', ...result };
  });
