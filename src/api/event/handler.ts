import { Request } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EventHandlerResponse } from 'src/api/event/types';

import { EventService } from '../../services/event/types';
import { Event, EventId, Events } from '../../types/domain/event.type';
import { APIError, APIErrorCode, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';

export const createEventHandlers = (eventService: EventService): EventHandlerResponse => {
  const getAllEvents = (): TE.TaskEither<APIError, Events> => {
    return pipe(eventService.getEvents(), TE.mapLeft(toAPIError));
  };

  const getCurrentEvent = (): TE.TaskEither<APIError, Event> => {
    return pipe(eventService.getCurrentEvent(), TE.mapLeft(toAPIError));
  };

  const getLastEvent = (): TE.TaskEither<APIError, Event> => {
    return pipe(eventService.getLastEvent(), TE.mapLeft(toAPIError));
  };

  const getNextEvent = (): TE.TaskEither<APIError, Event> => {
    return pipe(eventService.getNextEvent(), TE.mapLeft(toAPIError));
  };

  const getEventById = (req: Request): TE.TaskEither<APIError, Event> => {
    const eventId = Number(req.params.id);
    if (isNaN(eventId) || eventId <= 0 || eventId > 38) {
      return TE.left(
        createAPIError({
          code: APIErrorCode.VALIDATION_ERROR,
          message: 'Invalid event ID: must be a positive integer between 1 and 38',
        }),
      );
    }

    return pipe(eventService.getEvent(eventId as EventId), TE.mapLeft(toAPIError));
  };

  return {
    getAllEvents,
    getCurrentEvent,
    getLastEvent,
    getNextEvent,
    getEventById,
  };
};
