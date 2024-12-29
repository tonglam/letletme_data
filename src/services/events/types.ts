// Event service types module

import * as TE from 'fp-ts/TaskEither';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { EventCache } from '../../domains/events/types';
import type { ServiceError } from '../../types/errors.type';
import type { Event, EventId, EventRepository } from '../../types/events.type';

// Event service interface
export interface EventService {
  readonly getEvents: () => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly saveEvents: (events: readonly Event[]) => TE.TaskEither<ServiceError, readonly Event[]>;
}

// Event service dependencies
export interface EventServiceDependencies {
  readonly bootstrapApi: BootstrapApi;
  readonly eventCache: EventCache;
  readonly eventRepository: EventRepository;
}
