/**
 * Events routes module
 * @module api/routes/events
 */

import { Router } from 'express';
import type { ServiceContainer } from '../../services';
import { createEventHandlers } from '../handlers/events.handler';
import { createHandler, validateRequest } from '../middleware/core';
import { EventIdParams } from '../types';

/**
 * Creates and configures the events router
 * @param eventService - Event service from the service container
 * @returns Configured Express router for events endpoints
 */
export const eventRouter = ({ eventService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createEventHandlers(eventService);

  router.get('/', createHandler(handlers.getAllEvents));

  router.get('/current', createHandler(handlers.getCurrentEvent));

  router.get('/next', createHandler(handlers.getNextEvent));

  router.get('/:id', validateRequest(EventIdParams), createHandler(handlers.getEventById));

  return router;
};
