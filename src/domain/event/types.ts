/**
 * Events Domain Types Module
 * Contains all type definitions specific to the events domain.
 * Centralizes type definitions for operations, repository, and cache layers.
 */

import { TaskEither } from 'fp-ts/TaskEither';
import { CacheError, DBError, DomainError } from '../../types/errors.type';
import { Event, EventId, PrismaEvent } from '../../types/events.type';

/**
 * Data provider interface for fetching event data.
 * Abstracts the underlying data source for the cache layer.
 */
export interface EventDataProvider {
  readonly getOne: (id: EventId) => Promise<Event | null>;
  readonly getAll: () => Promise<readonly Event[]>;
  readonly getCurrentEvent: () => Promise<Event | null>;
  readonly getNextEvent: () => Promise<Event | null>;
}

/**
 * Event cache configuration interface.
 * Defines required configuration for event caching.
 */
export interface EventCacheConfig {
  readonly keyPrefix: string;
  readonly season: string;
}

/**
 * Event cache interface.
 * Defines all caching operations available for events.
 */
export interface EventCache {
  readonly cacheEvent: (event: Event) => TaskEither<CacheError, void>;
  readonly getEvent: (id: string) => TaskEither<CacheError, Event | null>;
  readonly cacheEvents: (events: readonly Event[]) => TaskEither<CacheError, void>;
  readonly getAllEvents: () => TaskEither<CacheError, readonly Event[]>;
  readonly getCurrentEvent: () => TaskEither<CacheError, Event | null>;
  readonly getNextEvent: () => TaskEither<CacheError, Event | null>;
  readonly warmUp: () => TaskEither<CacheError, void>;
}

/**
 * Event operations interface.
 * Defines high-level domain operations for events.
 */
export interface EventOperations {
  readonly getAllEvents: () => TaskEither<DomainError, readonly Event[]>;
  readonly getEventById: (id: EventId) => TaskEither<DomainError, Event | null>;
  readonly getCurrentEvent: () => TaskEither<DomainError, Event | null>;
  readonly getNextEvent: () => TaskEither<DomainError, Event | null>;
  readonly createEvent: (event: Event) => TaskEither<DomainError, Event>;
  readonly createEvents: (events: readonly Event[]) => TaskEither<DomainError, readonly Event[]>;
}

/**
 * Event repository operations interface.
 * Defines low-level data access operations for events.
 */
export interface EventRepositoryOperations {
  readonly findAll: () => TaskEither<DBError, PrismaEvent[]>;
  readonly findById: (id: EventId) => TaskEither<DBError, PrismaEvent | null>;
  readonly findByIds: (ids: EventId[]) => TaskEither<DBError, PrismaEvent[]>;
  readonly findCurrent: () => TaskEither<DBError, PrismaEvent | null>;
  readonly findNext: () => TaskEither<DBError, PrismaEvent | null>;
  readonly create: (event: Event) => TaskEither<DBError, PrismaEvent>;
  readonly createMany: (events: readonly Event[]) => TaskEither<DBError, PrismaEvent[]>;
  readonly update: (id: EventId, event: Partial<Event>) => TaskEither<DBError, PrismaEvent>;
  readonly delete: (id: EventId) => TaskEither<DBError, PrismaEvent>;
}
