/**
 * Events API routes module
 * @module api/routes/events
 */

import { RequestHandler, Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { ServiceContainer } from '../../services';
import { EventId } from '../../types/events.type';
import { logApiError, logApiRequest } from '../../utils/logger.util';
import { formatErrorResponse, formatResponse } from '../responses';
import { ApiRequest } from '../types';

/**
 * Creates and configures the events router
 * @param eventService - Event service from the service container
 * @returns Configured Express router for events endpoints
 */
export const eventRouter = ({ eventService }: ServiceContainer): Router => {
  // Initialize router
  const router = Router();

  /**
   * Handler for retrieving all events
   */
  const getAllEvents: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get all events');

    pipe(
      await eventService.getEvents()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (events) => res.json(formatResponse(events)),
      ),
    );
  };

  /**
   * Handler for retrieving the current event
   */
  const getCurrentEvent: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get current event');

    pipe(
      await eventService.getCurrentEvent()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (event) => res.json(formatResponse(event)),
      ),
    );
  };

  /**
   * Handler for retrieving the next event
   */
  const getNextEvent: RequestHandler = async (req, res) => {
    logApiRequest(req as ApiRequest, 'Get next event');

    pipe(
      await eventService.getNextEvent()(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (event) => res.json(formatResponse(event)),
      ),
    );
  };

  /**
   * Handler for retrieving an event by ID
   */
  const getEventById: RequestHandler = async (req, res) => {
    const eventId = Number(req.params.id) as EventId;
    logApiRequest(req as ApiRequest, 'Get event by ID', { eventId });

    pipe(
      await eventService.getEvent(eventId)(),
      E.fold(
        (error) => {
          logApiError(req as ApiRequest, error as Error);
          res.status(500).json(formatErrorResponse(error as Error));
        },
        (event) => res.json(formatResponse(event)),
      ),
    );
  };

  // Register routes
  router.get('/events/', getAllEvents);
  router.get('/events/current', getCurrentEvent);
  router.get('/events/next', getNextEvent);
  router.get('/events/:id', getEventById);

  return router;
};
