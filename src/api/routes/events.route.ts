import { RequestHandler, Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { ServiceContainer } from '../../services';
import { EventId } from '../../types/events.type';
import { logApiError, logApiRequest } from '../../utils/logger';
import { formatErrorResponse, formatResponse } from '../responses';
import { ApiRequest } from '../types';

export const eventRouter = ({ eventService }: ServiceContainer): Router => {
  // Initialize router
  const router = Router();

  // Routes
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
