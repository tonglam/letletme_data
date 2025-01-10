// Event Handlers Module
// Provides handlers for event-related API endpoints using functional programming
// patterns with fp-ts. Handles event retrieval operations including getting all events,
// current event, next event, and specific events by ID.

import { Request } from 'express';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { ServiceContainer, ServiceKey } from '../../service';
import { APIError, APIErrorCode, ServiceError, createAPIError } from '../../types/error.type';
import { Event, EventId } from '../../types/event.type';
import { handleNullable, toAPIError } from '../../utils/error.util';
import { EventHandlerResponse } from '../types';

// Helper function to convert service errors to API errors while preserving error information
const handleServiceError = <T>(task: TE.TaskEither<ServiceError, T>): TE.TaskEither<APIError, T> =>
  pipe(
    task,
    TE.mapLeft((error) => {
      if (error.name === 'ServiceError') {
        return createAPIError({
          code: APIErrorCode.SERVICE_ERROR,
          message: error.message,
          details: error.details,
          cause: error.cause,
        });
      }
      return toAPIError(error);
    }),
  );

// Creates event handlers with dependency injection
export const createEventHandlers = (
  eventService: ServiceContainer[typeof ServiceKey.EVENT],
): EventHandlerResponse => ({
  // Retrieves all events
  getAllEvents: () => {
    const task = eventService.getEvents();
    return pipe(
      () => task(),
      handleServiceError,
      TE.map((events) => [...events]),
    );
  },

  // Gets the current active event
  getCurrentEvent: () => {
    const task = eventService.getCurrentEvent();
    return pipe(
      () => task(),
      handleServiceError,
      TE.chain(
        (event) => () => Promise.resolve(handleNullable<Event>('Current event not found')(event)),
      ),
    );
  },

  // Gets the next scheduled event
  getNextEvent: () => {
    const task = eventService.getNextEvent();
    return pipe(
      () => task(),
      handleServiceError,
      TE.chain(
        (event) => () => Promise.resolve(handleNullable<Event>('Next event not found')(event)),
      ),
    );
  },

  // Retrieves a specific event by ID
  getEventById: (req: Request) => {
    const eventId = Number(req.params.id);
    if (isNaN(eventId) || eventId <= 0) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid event ID: must be a positive integer',
        }),
      );
    }
    const task = eventService.getEvent(eventId as EventId);
    return pipe(
      task,
      handleServiceError,
      TE.chain(
        (event) => () =>
          Promise.resolve(handleNullable<Event>(`Event with ID ${eventId} not found`)(event)),
      ),
    );
  },
});
