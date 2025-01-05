/**
 * Events Domain Types Module
 * Contains type definitions for the events domain layer.
 * Organizes types hierarchically from low-level (repository) to high-level (operations).
 */

import { TaskEither } from 'fp-ts/TaskEither';
import { CacheError, DBError, DomainError } from '../../types/errors.type';
import { Event, EventId, PrismaEvent } from '../../types/events.type';

/**
 * Low-level repository operations.
 * Handles direct database access with minimal business logic.
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
  readonly deleteAll: () => TaskEither<DBError, void>;
}

/**
 * Cache configuration.
 * Internal to the cache implementation.
 */
export interface EventCacheConfig {
  readonly keyPrefix: string;
  readonly season: string;
}

/**
 * Internal data provider for cache initialization.
 * Used by the cache implementation for data seeding.
 */
export interface EventDataProvider {
  readonly getOne: (id: number) => Promise<Event | null>;
  readonly getAll: () => Promise<Event[]>;
  readonly getCurrentEvent: () => Promise<Event | null>;
  readonly getNextEvent: () => Promise<Event | null>;
}

/**
 * Mid-level cache operations.
 * Provides caching functionality with error handling.
 */
export interface EventCache {
  readonly warmUp: () => TaskEither<CacheError, void>;
  readonly cacheEvent: (event: Event) => TaskEither<CacheError, void>;
  readonly getEvent: (id: string) => TaskEither<CacheError, Event | null>;
  readonly cacheEvents: (events: readonly Event[]) => TaskEither<CacheError, void>;
  readonly getAllEvents: () => TaskEither<CacheError, readonly Event[]>;
  readonly getCurrentEvent: () => TaskEither<CacheError, Event | null>;
  readonly getNextEvent: () => TaskEither<CacheError, Event | null>;
}

/**
 * High-level domain operations.
 * Implements business logic, combining repository and cache operations.
 * Main interface used by the service layer.
 */
export interface EventOperations {
  readonly getAllEvents: () => TaskEither<DomainError, readonly Event[]>;
  readonly getEventById: (id: EventId) => TaskEither<DomainError, Event | null>;
  readonly getCurrentEvent: () => TaskEither<DomainError, Event | null>;
  readonly getNextEvent: () => TaskEither<DomainError, Event | null>;
  readonly createEvent: (event: Event) => TaskEither<DomainError, Event>;
  readonly createEvents: (events: readonly Event[]) => TaskEither<DomainError, readonly Event[]>;
  readonly deleteAll: () => TaskEither<DomainError, void>;
}
