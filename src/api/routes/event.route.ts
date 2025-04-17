import { Router } from 'express';
import * as t from 'io-ts';
import { ServiceContainer } from 'services/types';
import { createEventHandlers } from '../handlers/event.handler';
import { createHandler, validateRequest } from '../middlewares/core';

const EventIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

export const eventRouter = ({ eventService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createEventHandlers(eventService);

  router.get('/', createHandler(handlers.getAllEvents));
  router.get('/current', createHandler(handlers.getCurrentEvent));
  router.get('/next', createHandler(handlers.getNextEvent));
  router.get('/:id', validateRequest(EventIdParams), createHandler(handlers.getEventById));

  return router;
};
