import { Router } from 'express';
import { EventService } from '../../services/event/types';

import { createEventHandlers } from '../handlers/event.handler';
import { createHandler } from '../middlewares/core';

export const eventRouter = (eventService: EventService): Router => {
  const router = Router();
  const handlers = createEventHandlers(eventService);

  router.get('/', createHandler(handlers.getAllEvents));
  router.get('/current', createHandler(handlers.getCurrentEvent));
  router.get('/next', createHandler(handlers.getNextEvent));
  router.get('/:id', createHandler(handlers.getEventById));

  return router;
};
