import { Router } from 'express';
import { createEventHandlers } from 'src/api/event/handler';

import { EventService } from '../../services/event/types';
import { createHandler } from '../middlewares/core';

export const eventRouter = (eventService: EventService): Router => {
  const router = Router();
  const handlers = createEventHandlers(eventService);

  router.get('/', createHandler(handlers.getAllEvents));
  router.get('/current', createHandler(handlers.getCurrentEvent));
  router.get('/last', createHandler(handlers.getLastEvent));
  router.get('/next', createHandler(handlers.getNextEvent));
  router.get('/:id', createHandler(handlers.getEventById));

  return router;
};
