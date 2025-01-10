/**
 * Event Domain Types Module
 *
 * Re-exports core type definitions from the types layer.
 */

import { BootstrapApi } from 'domains/bootstrap/types';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/config/cache/cache.config';
import { APIError, CacheError, DomainError } from 'src/types/error.type';
import { Event, EventId, EventRepository, Events } from 'src/types/event.type';

/**
 * Event data provider interface
 */
export interface EventDataProvider {
  readonly getOne: (id: number) => Promise<Event | null>;
  readonly getAll: () => Promise<readonly Event[]>;
  readonly getCurrent: () => Promise<Event | null>;
  readonly getNext: () => Promise<Event | null>;
}

/**
 * Event cache configuration interface
 */
export interface EventCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

/**
 * Event cache interface
 */
export interface EventCache {
  readonly warmUp: () => TE.TaskEither<CacheError, void>;
  readonly cacheEvent: (event: Event) => TE.TaskEither<CacheError, void>;
  readonly cacheEvents: (events: readonly Event[]) => TE.TaskEither<CacheError, void>;
  readonly getEvent: (id: string) => TE.TaskEither<CacheError, Event | null>;
  readonly getAllEvents: () => TE.TaskEither<CacheError, readonly Event[]>;
  readonly getCurrentEvent: () => TE.TaskEither<CacheError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<CacheError, Event | null>;
}

/**
 * Event operations interface
 */
export interface EventOperations {
  readonly getAllEvents: () => TE.TaskEither<DomainError, Events>;
  readonly getEventById: (id: EventId) => TE.TaskEither<DomainError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<DomainError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<DomainError, Event | null>;
  readonly createEvents: (events: Events) => TE.TaskEither<DomainError, Events>;
  readonly deleteAll: () => TE.TaskEither<DomainError, void>;
}

/**
 * Event service interface
 */
export interface EventService {
  readonly getEvents: () => TE.TaskEither<APIError, Events>;
  readonly getEventById: (id: EventId) => TE.TaskEither<APIError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<APIError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<APIError, Event | null>;
  readonly saveEvents: (events: Events) => TE.TaskEither<APIError, Events>;
  readonly syncEventsFromApi: () => TE.TaskEither<APIError, Events>;
}

/**
 * Event service dependencies interface
 */
export interface EventServiceDependencies {
  bootstrapApi: BootstrapApi;
  eventCache: EventCache;
  eventRepository: EventRepository;
}

export * from '../../types/event.type';
