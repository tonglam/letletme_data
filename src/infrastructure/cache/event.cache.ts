import { EventCachePort } from '@app/domain/event/cache';
import { Event, EventSchema } from '@app/domain/event/schema';
import { EventID } from '@app/domain/shared/types/id.types';
import { parseAndValidateJson, parseJsonMap } from '@app/infrastructure/cache/parse.util';
import { CacheConfig, redisClient } from '@app/infrastructure/cache/redis-client';
import { CachePrefix, DefaultTTL } from '@app/infrastructure/config/cache.config';
import { CacheError, CacheErrorCode, createCacheError } from '@app/shared/types/error.types';
import { getCurrentSeason } from '@app/shared/utils/common.util';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { z, ZodError } from 'zod';

export const createEventCache = (
  config: CacheConfig = {
    keyPrefix: CachePrefix.EVENT,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.EVENT,
  },
): EventCachePort => {
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
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chainW((cachedEventStrOrNull) =>
        pipe(
          O.fromNullable(cachedEventStrOrNull),
          O.match(
            () =>
              TE.left(
                createCacheError({
                  code: CacheErrorCode.NOT_FOUND,
                  message: 'Current event not found in cache',
                }),
              ),
            (cachedEventStr: string) =>
              pipe(parseAndValidateJson(cachedEventStr, EventSchema), TE.fromEither),
          ),
        ),
      ),
    );

  const setCurrentEvent = (event: Event): TE.TaskEither<CacheError, void> =>
    pipe(
      E.tryCatch(
        () => EventSchema.parse(event),
        (error: unknown): CacheError => {
          if (error instanceof ZodError) {
            return formatZodErrorForCache(error, 'setCurrentEvent');
          }
          return createCacheError({
            code: CacheErrorCode.SERIALIZATION_ERROR,
            message: 'Unknown error during event validation before cache set',
            cause: error instanceof Error ? error : new Error(String(error)),
          });
        },
      ),
      TE.fromEither,
      TE.chain((validEvent) =>
        TE.tryCatch(
          () =>
            redisClient.set(
              currentEventKey,
              JSON.stringify(validEvent),
              'EX',
              DefaultTTL.EVENT_CURRENT,
            ),
          (error: unknown) =>
            createCacheError({
              code: CacheErrorCode.OPERATION_ERROR,
              message: `Cache Write Error: Failed to set current event ${event.id}`,
              cause: error instanceof Error ? error : new Error(String(error)),
            }),
        ),
      ),
      TE.map(() => undefined),
    );

  const clearCurrentEvent = (): TE.TaskEither<CacheError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.del(currentEventKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to clear current event',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.map(() => undefined),
    );

  const getEvent = (id: EventID): TE.TaskEither<CacheError, Event> =>
    pipe(
      getAllEvents(),
      TE.chain((events) => {
        const event = events.find((e) => e.id === id);
        if (!event) {
          return TE.left(
            createCacheError({
              code: CacheErrorCode.NOT_FOUND,
              message: `Event ${id} not found in cache`,
            }),
          );
        }
        return TE.right(event);
      }),
    );

  const getAllEvents = (): TE.TaskEither<CacheError, Event[]> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all events',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chainW(
        flow(
          O.fromNullable,
          O.filter((eventsMap) => Object.keys(eventsMap).length > 0),
          O.fold(
            () => TE.right([] as Event[]),
            (cachedEvents): TE.TaskEither<CacheError, Event[]> =>
              pipe(parseJsonMap(cachedEvents, EventSchema), TE.fromEither),
          ),
        ),
      ),
    );

  const setAllEvents = (events: Event[]): TE.TaskEither<CacheError, void> =>
    pipe(
      E.tryCatch(
        () => z.array(EventSchema).parse(events),
        (error: unknown): CacheError => {
          if (error instanceof ZodError) {
            return formatZodErrorForCache(error, 'setAllEvents');
          }
          return createCacheError({
            code: CacheErrorCode.SERIALIZATION_ERROR,
            message: 'Unknown error during event array validation before cache set',
            cause: error instanceof Error ? error : new Error(String(error)),
          });
        },
      ),
      TE.fromEither,
      TE.chain((validEvents) =>
        TE.tryCatch(
          async () => {
            const multi = redisClient.multi();
            multi.del(baseKey);
            if (validEvents.length > 0) {
              const items: Record<string, string> = {};
              validEvents.forEach((event) => {
                items[String(event.id)] = JSON.stringify(event);
              });
              multi.hset(baseKey, items);
            }
            await multi.exec();
          },
          (error: unknown) =>
            createCacheError({
              code: CacheErrorCode.OPERATION_ERROR,
              message: 'Failed to set all events in cache hash',
              cause: error instanceof Error ? error : new Error(String(error)),
            }),
        ),
      ),
      TE.map(() => undefined),
    );

  return {
    getCurrentEvent,
    setAllEvents,
    setCurrentEvent,
    getEvent,
    getAllEvents,
    clearCurrentEvent,
  };
};
