import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { Event, EventId, Events } from 'src/types/domain/event.type';

import { CachePrefix } from '../../configs/cache/cache.config';
import { redisClient } from '../../infrastructures/cache/client';
import { getCurrentSeason } from '../../types/base.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from '../../types/error.type';
import { mapCacheErrorToDomainError, mapRepositoryErrorToCacheError } from '../../utils/error.util';
import { EventCache, EventCacheConfig, EventRepository } from './types';

const parseEvent = (eventStr: string): E.Either<CacheError, Event | null> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(eventStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse event JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as Event)
        : E.right(null),
    ),
  );

const parseEvents = (events: Record<string, string>): E.Either<CacheError, Event[]> =>
  pipe(
    Object.values(events),
    (eventStrs) =>
      eventStrs.map((str) =>
        pipe(
          parseEvent(str),
          E.getOrElse<CacheError, Event | null>(() => null),
        ),
      ),
    (parsedEvents) => parsedEvents.filter((event): event is Event => event !== null),
    (validEvents) => E.right(validEvents),
  );

export const createEventCache = (
  repository: EventRepository,
  config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
  },
): EventCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getEvent = (id: EventId): TE.TaskEither<DomainError, Event | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, id.toString()),
        (error) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get event',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                repository.findById(id),
                TE.mapLeft(mapRepositoryErrorToCacheError('Repository Error: Failed to get event')),
              ),
            (eventStr) => pipe(parseEvent(eventStr), TE.fromEither),
          ),
        ),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  const getAllEvents = (): TE.TaskEither<DomainError, Events | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all events',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.filter((eventsMap) => Object.keys(eventsMap).length > 0),
          O.fold(
            () =>
              pipe(
                repository.findAll(),
                TE.mapLeft(
                  mapRepositoryErrorToCacheError('Repository Error: Failed to get all events'),
                ),
                TE.mapLeft(mapCacheErrorToDomainError),
                TE.chainFirst((events) => setAllEvents(events)),
              ),
            (cachedEvents) =>
              pipe(
                parseEvents(cachedEvents),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
      TE.map((events) => (events.length > 0 ? events : null)),
    );

  const setAllEvents = (events: Events): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(baseKey);
          if (events.length > 0) {
            const items: Record<string, string> = {};
            events.forEach((event) => {
              items[event.id.toString()] = JSON.stringify(event);
            });
            multi.hset(baseKey, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to set all events in cache hash',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  const deleteAllEvents = (): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.del(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to delete all events',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getEvent,
    getAllEvents,
    setAllEvents,
    deleteAllEvents,
  };
};
