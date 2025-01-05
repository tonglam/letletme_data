// Event service types module

import { ExtendedBootstrapApi } from 'domains/bootstrap/types';
import * as TE from 'fp-ts/TaskEither';
import type { EventCache, EventRepositoryOperations } from '../../domain/event/types';
import type { ServiceError } from '../../types/errors.type';
import type { Event, EventId } from '../../types/events.type';

// Event service interface
export interface EventService {
  readonly getEvents: () => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly saveEvents: (events: readonly Event[]) => TE.TaskEither<ServiceError, readonly Event[]>;
  readonly syncEventsFromApi: () => TE.TaskEither<ServiceError, readonly Event[]>;
}

// Event service dependencies
export interface EventServiceDependencies {
  readonly bootstrapApi: ExtendedBootstrapApi;
  readonly eventCache: EventCache;
  readonly eventRepository: EventRepositoryOperations;
}

// Event service operations
export interface EventServiceOperations {
  readonly findAllEvents: (
    repository: EventRepositoryOperations,
    cache: EventCache,
  ) => TE.TaskEither<ServiceError, readonly Event[]>;

  readonly findEventById: (
    repository: EventRepositoryOperations,
    cache: EventCache,
    id: EventId,
  ) => TE.TaskEither<ServiceError, Event | null>;

  readonly findCurrentEvent: (
    repository: EventRepositoryOperations,
    cache: EventCache,
  ) => TE.TaskEither<ServiceError, Event | null>;

  readonly findNextEvent: (
    repository: EventRepositoryOperations,
    cache: EventCache,
  ) => TE.TaskEither<ServiceError, Event | null>;

  readonly syncEventsFromApi: (
    bootstrapApi: EventServiceDependencies['bootstrapApi'],
    repository: EventRepositoryOperations,
    cache: EventCache,
  ) => TE.TaskEither<ServiceError, readonly Event[]>;
}

// Event service configuration
export interface EventServiceConfig {
  readonly bootstrapApi: EventServiceDependencies['bootstrapApi'];
  readonly repository: EventRepositoryOperations;
  readonly cache?: EventCache;
}
