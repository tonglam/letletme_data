// Events Router Module
// Provides Express router configuration for FPL event endpoints.
// Handles routes for retrieving event (gameweek) information:
// - All events in the season
// - Current active event
// - Next scheduled event
// - Specific event by ID
//
// Routes follow RESTful principles with functional programming patterns,
// error handling and request validation.

import { Router } from 'express';
import * as t from 'io-ts';
import type { ServiceContainer } from '../../service';
import { createEventHandlers } from '../handlers/events.handler';
import { createHandler, validateRequest } from '../middleware/core';

// io-ts codec for validating event ID parameters
// Ensures the ID is a positive integer as required by the FPL API
const EventIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

// Creates and configures the events router with request handling and validation
// Uses dependency injection to receive the event service for loose coupling
export const eventRouter = ({ eventService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createEventHandlers(eventService);

  // GET /events - Retrieves all events (gameweeks) in the current season
  router.get('/', createHandler(handlers.getAllEvents));

  // GET /events/current - Retrieves the currently active event (gameweek)
  router.get('/current', createHandler(handlers.getCurrentEvent));

  // GET /events/next - Retrieves the next scheduled event (gameweek)
  router.get('/next', createHandler(handlers.getNextEvent));

  // GET /events/:id - Retrieves a specific event by its ID (1-38 for regular season)
  router.get('/:id', validateRequest(EventIdParams), createHandler(handlers.getEventById));

  return router;
};
