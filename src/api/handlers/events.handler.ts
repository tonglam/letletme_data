// Event Handlers Module
// Provides handlers for event-related API endpoints using functional programming
// patterns with fp-ts. Handles event retrieval operations including getting all events,
// current event, next event, and specific events by ID.

import { Request } from 'express';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { ServiceContainer, ServiceKey } from '../../services';
import { Event, EventId } from '../../types/events.type';
import { handleNullable } from '../../utils/error.util';
import { EventHandlerResponse } from '../types';

// Creates event handlers with dependency injection
export const createEventHandlers = (
  eventService: ServiceContainer[typeof ServiceKey.EVENT],
): EventHandlerResponse => ({
  // Retrieves all events
  getAllEvents: () => {
    const task = eventService.getEvents();
    return pipe(
      () => task(),
      TE.map((events) => [...events]),
    );
  },

  // Gets the current active event
  getCurrentEvent: () => {
    const task = eventService.getCurrentEvent();
    return pipe(
      () => task(),
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
      TE.chain(
        (event) => () => Promise.resolve(handleNullable<Event>('Next event not found')(event)),
      ),
    );
  },

  // Retrieves a specific event by ID
  getEventById: (req: Request) => {
    const eventId = Number(req.params.id) as EventId;
    const task = eventService.getEvent(eventId);
    return pipe(
      () => task(),
      TE.chain(
        (event) => () =>
          Promise.resolve(handleNullable<Event>(`Event with ID ${eventId} not found`)(event)),
      ),
    );
  },
});
