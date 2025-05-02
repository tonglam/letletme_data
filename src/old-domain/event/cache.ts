import { EventCache, EventCacheConfig } from 'domain/event/types';

import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { redisClient } from 'infrastructure/cache/client';
import { Event, EventId, Events } from 'types/domain/event.type';
import { CacheError, CacheErrorCode, createCacheError } from 'types/error.type';
import { getCurrentSeason } from 'utils/common.util';

const parseEvent = (eventStr: string): E.Either<CacheError, Event> =>
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
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid Event structure',
            }),
          ),
    ),
  );

const parseEvents = (eventMaps: Record<string, string>): E.Either<CacheError, Events> =>
  pipe(
    Object.values(eventMaps),
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
  config: EventCacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.EVENT,
  },
): EventCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;
  const currentEventKey = `${baseKey}::current`;

  const getCurrentEvent = (): TE.TaskEither<CacheError, Event> =>
    pipe(
      TE.tryCatch(
        () => redisClient.get(currentEventKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get current event',
            cause: error as Error,
          }),
      ),
      TE.chainW((cachedEventStrOrNull) =>
        pipe(
          O.fromNullable(cachedEventStrOrNull),
          O.match(
            (): TE.TaskEither<CacheError, Event> =>
              pipe(
                TE.left(
                  createCacheError({
                    code: CacheErrorCode.NOT_FOUND,
                    message: 'Current event not found in cache',
                  }),
                ),
              ),
            (cachedEventStr: string): TE.TaskEither<CacheError, Event> =>
              pipe(parseEvent(cachedEventStr), TE.fromEither),
          ),
        ),
      ),
    );

  const getLastEvent = (): TE.TaskEither<CacheError, Event> =>
    pipe(
      getAllEvents(),
      TE.chain((events) => {
        const currentEventIndex = events.findIndex((e) => e.isCurrent);
        if (currentEventIndex <= 0) {
          return pipe(
            TE.left(
              createCacheError({
                code: CacheErrorCode.NOT_FOUND,
                message: 'Cannot determine last event based on current event position.',
              }),
            ),
          );
        }
        return TE.right(events[currentEventIndex - 1]);
      }),
    );

  const getNextEvent = (): TE.TaskEither<CacheError, Event> =>
    pipe(
      getAllEvents(),
      TE.chain((events) => {
        const currentEventIndex = events.findIndex((e) => e.isCurrent);
        if (currentEventIndex === -1 || currentEventIndex === events.length - 1) {
          return pipe(
            TE.left(
              createCacheError({
                code: CacheErrorCode.NOT_FOUND,
                message: 'Cannot determine next event based on current event position.',
              }),
            ),
          );
        }
        return TE.right(events[currentEventIndex + 1]);
      }),
    );

  const setCurrentEvent = (event: Event): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          redisClient.set(currentEventKey, JSON.stringify(event), 'EX', DefaultTTL.EVENT_CURRENT),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: `Cache Write Error: Failed to set current event ${event.id}`,
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
    );

  const getEvent = (id: EventId): TE.TaskEither<CacheError, Event> =>
    pipe(
      getAllEvents(),
      TE.chain((events) => {
        const event = events.find((e) => e.id === id);
        if (!event) {
          return pipe(
            TE.left(
              createCacheError({
                code: CacheErrorCode.NOT_FOUND,
                message: 'Event not found in cache',
              }),
            ),
          );
        }
        return TE.right(event);
      }),
    );

  const getAllEvents = (): TE.TaskEither<CacheError, Events> =>
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
      TE.chainW(
        flow(
          O.fromNullable,
          O.filter((eventsMap) => Object.keys(eventsMap).length > 0),
          O.fold(
            () => TE.right([] as Events),
            (cachedEvents): TE.TaskEither<CacheError, Events> =>
              pipe(parseEvents(cachedEvents), TE.fromEither),
          ),
        ),
      ),
    );

  const setAllEvents = (events: Events): TE.TaskEither<CacheError, void> =>
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
    );

  return {
    getAllEvents,
    getCurrentEvent,
    getLastEvent,
    getNextEvent,
    setAllEvents,
    setCurrentEvent,
    getEvent,
  };
};
