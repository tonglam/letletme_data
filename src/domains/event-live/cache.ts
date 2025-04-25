import { EventLiveCache } from 'domains/event-live/types';
import { EventLiveCacheConfig } from 'domains/event-live/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { EventLive, EventLives } from 'src/types/domain/event-live.type';
import { EventId } from 'src/types/domain/event.type';
import { getCurrentSeason } from 'src/utils/common.util';

import { CachePrefix } from '../../configs/cache/cache.config';
import { redisClient } from '../../infrastructures/cache/client';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from '../../types/error.type';
import { mapCacheErrorToDomainError } from '../../utils/error.util';

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
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
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
          O.filter((eventLivesMap) => Object.keys(eventLivesMap).length > 0),
          O.fold(
            () => TE.right([] as EventLives),
            (cachedEventLives): TE.TaskEither<DomainError, EventLives> =>
              pipe(
                parseEventLives(cachedEventLives),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
    );

  const setEventLives = (eventLives: EventLives): TE.TaskEither<DomainError, void> => {
    const eventId = eventLives[0].eventId;

    return pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(`${baseKey}::${eventId}`);
          if (eventLives.length > 0) {
            const items: Record<string, string> = {};
            eventLives.forEach((eventLive) => {
              items[eventLive.eventId.toString()] = JSON.stringify(eventLive);
            });
            multi.hset(`${baseKey}::${eventId}`, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to set all event lives in cache hash',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );
  };

  return {
    getEventLives,
    setEventLives,
  };
};
