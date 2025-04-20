import { Router } from 'express';
import { createEventHandlers } from 'src/api/event/event.handler';

import { EventService } from '../../services/event/types';
import { createHandler } from '../middlewares/core';

export const eventRouter = (eventService: EventService): Router => {
  const router = Router();
  const handlers = createEventHandlers(eventService);

  router.get('/', createHandler(handlers.getAllEvents));
  router.get('/:id', createHandler(handlers.getEventById));
  router.get('/current', createHandler(handlers.getCurrentEvent));
  router.get('/last', createHandler(handlers.getLastEvent));
  router.get('/next', createHandler(handlers.getNextEvent));

  return router;
};
