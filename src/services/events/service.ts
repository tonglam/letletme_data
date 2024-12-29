// Event Service Module
// Provides business logic for Event operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import { Prisma } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { BootstrapApi } from '../../domains/bootstrap/operations';
import { EventCache } from '../../domains/events/cache';
import { CacheError } from '../../infrastructure/cache/types';
import { APIError, APIErrorCode, createAPIError } from '../../types/errors.type';
import {
  Event,
  EventId,
  EventRepository,
  PrismaEventCreate,
  toDomainEvent,
} from '../../types/events.type';
import { EventService } from './types';

// Dependencies required for the event service
export interface EventServiceDependencies {
  readonly bootstrapApi: BootstrapApi;
  readonly eventRepository: EventRepository;
  readonly eventCache: EventCache;
}

// Creates a service error from an API error
const createEventServiceError = (error: APIError): APIError =>
  createAPIError({
    code: APIErrorCode.SERVICE_ERROR,
    message: 'Event service operation failed',
    details: error,
  });

// Creates an API error from a cache error
const createCacheError = (error: CacheError): APIError =>
  createAPIError({
    code: APIErrorCode.SERVICE_ERROR,
    message: error.message,
    cause: error.cause instanceof Error ? error.cause : undefined,
  });

/**
 * Finds all events using repository and cache
 */
const findAllEvents = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, readonly Event[]> =>
  pipe(
    cache.getAllEvents(),
    TE.mapLeft(createCacheError),
    TE.chain((cached) =>
      cached.length > 0
        ? TE.right(cached)
        : pipe(
            repository.findAll(),
            TE.chain((events) =>
              pipe(events.map(toDomainEvent), (domainEvents) =>
                pipe(
                  cache.cacheEvents(domainEvents),
                  TE.mapLeft(createCacheError),
                  TE.map(() => domainEvents),
                ),
              ),
            ),
          ),
    ),
  );

/**
 * Finds an event by ID using repository and cache
 */
const findEventById = (
  repository: EventRepository,
  cache: EventCache,
  id: EventId,
): TE.TaskEither<APIError, Event | null> =>
  pipe(
    cache.getEvent(id.toString()),
    TE.mapLeft(createCacheError),
    TE.chain((cached) =>
      cached
        ? TE.right(cached)
        : pipe(
            repository.findById(id),
            TE.chain((event) =>
              event
                ? pipe(toDomainEvent(event), (domainEvent) =>
                    pipe(
                      cache.cacheEvent(domainEvent),
                      TE.mapLeft(createCacheError),
                      TE.map(() => domainEvent),
                    ),
                  )
                : TE.right(null),
            ),
          ),
    ),
  );

/**
 * Finds the current event using repository and cache
 */
const findCurrentEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, Event | null> =>
  pipe(
    cache.getCurrentEvent(),
    TE.mapLeft(createCacheError),
    TE.chain((cached) =>
      cached
        ? TE.right(cached)
        : pipe(
            repository.findCurrent(),
            TE.chain((event) =>
              event
                ? pipe(toDomainEvent(event), (domainEvent) =>
                    pipe(
                      cache.cacheEvent(domainEvent),
                      TE.mapLeft(createCacheError),
                      TE.map(() => domainEvent),
                    ),
                  )
                : TE.right(null),
            ),
          ),
    ),
  );

/**
 * Finds the next event using repository and cache
 */
const findNextEvent = (
  repository: EventRepository,
  cache: EventCache,
): TE.TaskEither<APIError, Event | null> =>
  pipe(
    cache.getNextEvent(),
    TE.mapLeft(createCacheError),
    TE.chain((cached) =>
      cached
        ? TE.right(cached)
        : pipe(
            repository.findNext(),
            TE.chain((event) =>
              event
                ? pipe(toDomainEvent(event), (domainEvent) =>
                    pipe(
                      cache.cacheEvent(domainEvent),
                      TE.mapLeft(createCacheError),
                      TE.map(() => domainEvent),
                    ),
                  )
                : TE.right(null),
            ),
          ),
    ),
  );

/**
 * Saves a batch of events using repository and updates cache
 */
const saveBatchEvents = (
  repository: EventRepository,
  cache: EventCache,
  events: readonly Event[],
): TE.TaskEither<APIError, readonly Event[]> =>
  pipe(
    events.map((event) => ({
      ...event,
      id: Number(event.id),
      chipPlays: event.chipPlays as unknown as Prisma.JsonValue,
      topElementInfo: event.topElementInfo as unknown as Prisma.JsonValue,
    })) as PrismaEventCreate[],
    (prismaEvents) =>
      pipe(
        repository.saveBatch(prismaEvents),
        TE.chain((saved) =>
          pipe(saved.map(toDomainEvent), (domainEvents) =>
            pipe(
              cache.cacheEvents(domainEvents),
              TE.mapLeft(createCacheError),
              TE.map(() => domainEvents),
            ),
          ),
        ),
      ),
  );

/**
 * Creates an event service implementation
 */
export const createEventServiceImpl = ({
  eventRepository,
  eventCache,
}: EventServiceDependencies): EventService => ({
  getEvents: () =>
    pipe(findAllEvents(eventRepository, eventCache), TE.mapLeft(createEventServiceError)),
  getEvent: (id: EventId) =>
    pipe(findEventById(eventRepository, eventCache, id), TE.mapLeft(createEventServiceError)),
  getCurrentEvent: () =>
    pipe(findCurrentEvent(eventRepository, eventCache), TE.mapLeft(createEventServiceError)),
  getNextEvent: () =>
    pipe(findNextEvent(eventRepository, eventCache), TE.mapLeft(createEventServiceError)),
  saveEvents: (events: readonly Event[]) =>
    pipe(saveBatchEvents(eventRepository, eventCache, events), TE.mapLeft(createEventServiceError)),
});
