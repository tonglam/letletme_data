import { Request } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { EventService } from '../../services/event/types';
import { EventId } from '../../types/domain/event.type';
import { APIErrorCode, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';
import { EventHandlerResponse } from '../types';

export const createEventHandlers = (eventService: EventService): EventHandlerResponse => ({
  getAllEvents: () => {
    return pipe(
      eventService.getEvents(),
      TE.mapLeft(toAPIError),
      TE.map((events) => events),
    );
  },

  getCurrentEvent: () => {
    return pipe(
      eventService.getCurrentEvent(),
      TE.mapLeft(toAPIError),
      TE.chain((event) =>
        event === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: 'Current event not found',
              }),
            )
          : TE.right(event),
      ),
    );
  },

  getNextEvent: () => {
    return pipe(
      eventService.getNextEvent(),
      TE.mapLeft(toAPIError),
      TE.chain((event) =>
        event === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: 'Next event not found',
              }),
            )
          : TE.right(event),
      ),
    );
  },

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

    return pipe(
      eventService.getEvent(eventId as EventId),
      TE.mapLeft(toAPIError),
      TE.chain((event) =>
        event === null
          ? TE.left(
              createAPIError({
                code: APIErrorCode.NOT_FOUND,
                message: `Event with ID ${eventId} not found`,
              }),
            )
          : TE.right(event),
      ),
    );
  },
});
