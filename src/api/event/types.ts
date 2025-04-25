import { Request } from 'express';
import { TaskEither } from 'fp-ts/lib/TaskEither';

import { Event, Events } from '../../types/domain/event.type';
import { APIError } from '../../types/error.type';

export interface EventHandlerResponse {
  readonly getAllEvents: () => TaskEither<APIError, Events>;
  readonly getCurrentEvent: () => TaskEither<APIError, Event>;
  readonly getLastEvent: () => TaskEither<APIError, Event>;
  readonly getNextEvent: () => TaskEither<APIError, Event>;
  readonly getEventById: (req: Request) => TaskEither<APIError, Event>;
}
