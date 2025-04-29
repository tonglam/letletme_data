import { EventLiveCache } from 'domain/event-live/types';
import { EventLiveCacheConfig } from 'domain/event-live/types';

import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { redisClient } from 'infrastructure/cache/client';
import { EventLive, EventLives } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'types/error.type';
import { getCurrentSeason } from 'utils/common.util';
import { mapCacheErrorToDomainError } from 'utils/error.util';

const parseEventLive = (eventLiveStr: string): E.Either<CacheError, EventLive> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(eventLiveStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse event live JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed &&
      typeof parsed === 'object' &&
      'elementId' in parsed &&
      typeof parsed.elementId === 'number'
        ? E.right(parsed as EventLive)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid EventLive structure',
            }),
          ),
    ),
  );

const parseEventLives = (eventLiveMaps: Record<string, string>): E.Either<CacheError, EventLives> =>
  pipe(
    Object.values(eventLiveMaps),
    (eventLiveStrs) =>
      eventLiveStrs.map((str) =>
        pipe(
          parseEventLive(str),
          E.getOrElse<CacheError, EventLive | null>(() => null),
        ),
      ),
    (parsedEventLives) =>
      parsedEventLives.filter((eventLive): eventLive is EventLive => eventLive !== null),
    (validEventLives) => E.right(validEventLives),
  );

export const createEventLiveCache = (
  config: EventLiveCacheConfig = {
    keyPrefix: CachePrefix.LIVE,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.LIVE,
  },
): EventLiveCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getEventLives = (eventId: EventId): TE.TaskEither<DomainError, EventLives> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(`${baseKey}::${eventId}`),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all event lives',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.map((eventLivesMap) => {
            return eventLivesMap;
          }),
          O.filter((eventLivesMap) => Object.keys(eventLivesMap).length > 0),
          O.fold(
            () => TE.right([] as EventLives),
            (cachedEventLivesMap): TE.TaskEither<DomainError, EventLives> =>
              pipe(
                parseEventLives(cachedEventLivesMap),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
    );

  const setEventLives = (eventLives: EventLives): TE.TaskEither<DomainError, void> => {
    if (eventLives.length === 0) {
      return TE.right(undefined);
    }
    const eventId = eventLives[0].eventId;
    const redisKey = `${baseKey}::${eventId}`;

    return pipe(
      TE.tryCatch(
        async () => {
          const items: Record<string, string> = {};
          eventLives.forEach((eventLive) => {
            items[eventLive.elementId.toString()] = JSON.stringify(eventLive);
          });

          await redisClient.del(redisKey);
          await redisClient.hset(redisKey, items);
          if (config.ttlSeconds > 0) {
            await redisClient.expire(redisKey, config.ttlSeconds);
          }
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to set all event lives in cache hash',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.map(() => undefined),
    );
  };

  return {
    getEventLives,
    setEventLives,
  };
};
