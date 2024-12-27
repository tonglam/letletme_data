import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { fetchBootstrapEvents } from '../../domains/bootstrap/operations';
import {
  cacheEvent,
  createError,
  findAllEvents,
  findCurrentEvent,
  findEventById,
  findNextEvent,
  saveBatchEvents,
  toDomainEvent,
} from '../../domains/events/operations';
import type { CacheError } from '../../infrastructure/cache/types';
import type { APIError } from '../../infrastructure/http/common/errors';
import type { Event, EventId, PrismaEvent } from '../../types/events.type';
import type { EventService, EventServiceDependencies } from './types';

const convertPrismaEvents = (
  events: readonly PrismaEvent[],
): TE.TaskEither<APIError, readonly Event[]> =>
  pipe(
    events,
    TE.traverseArray((event) =>
      pipe(
        E.tryCatch(
          () => toDomainEvent(event),
          (error) => createError('Failed to convert event', error),
        ),
        TE.fromEither,
      ),
    ),
  );

const convertPrismaEvent = (event: PrismaEvent | null): TE.TaskEither<APIError, Event | null> =>
  event
    ? pipe(
        E.tryCatch(
          () => toDomainEvent(event),
          (error) => createError('Failed to convert event', error),
        ),
        TE.fromEither,
      )
    : TE.right(null);

const getCachedOrFallback = <T, R>(
  cachedValue: TE.TaskEither<CacheError, T> | undefined,
  fallback: TE.TaskEither<APIError, R>,
  convert: (value: T) => TE.TaskEither<APIError, R>,
): TE.TaskEither<APIError, R> =>
  cachedValue
    ? pipe(
        cachedValue,
        TE.mapLeft((error) => createError('Cache operation failed', error)),
        TE.chain(convert),
      )
    : fallback;

export const createEventServiceImpl = ({
  bootstrapApi,
  eventCache,
}: EventServiceDependencies): EventService => {
  const syncEvents = (): TE.TaskEither<APIError, readonly Event[]> =>
    pipe(
      fetchBootstrapEvents(bootstrapApi),
      TE.mapLeft((error) => createError('Bootstrap data fetch failed', error)),
      TE.chain((events) =>
        pipe(
          saveBatchEvents(events),
          TE.chainFirst((savedEvents) =>
            eventCache
              ? pipe(
                  savedEvents,
                  TE.traverseArray((event) => cacheEvent(eventCache)(event)),
                  TE.mapLeft((error) => createError('Failed to cache events', error)),
                )
              : TE.right(undefined),
          ),
        ),
      ),
    );

  const getEvents = (): TE.TaskEither<APIError, readonly Event[]> =>
    getCachedOrFallback(eventCache?.getAllEvents(), findAllEvents(), convertPrismaEvents);

  const getEvent = (id: EventId): TE.TaskEither<APIError, Event | null> =>
    getCachedOrFallback(eventCache?.getEvent(String(id)), findEventById(id), convertPrismaEvent);

  const getCurrentEvent = (): TE.TaskEither<APIError, Event | null> =>
    getCachedOrFallback(eventCache?.getCurrentEvent(), findCurrentEvent(), convertPrismaEvent);

  const getNextEvent = (): TE.TaskEither<APIError, Event | null> =>
    getCachedOrFallback(eventCache?.getNextEvent(), findNextEvent(), convertPrismaEvent);

  return {
    syncEvents,
    getEvents,
    getEvent,
    getCurrentEvent,
    getNextEvent,
  };
};
