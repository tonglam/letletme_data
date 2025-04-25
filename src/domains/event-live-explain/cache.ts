import {
  EventLiveExplainCache,
  EventLiveExplainCacheConfig,
} from 'domains/event-live-explain/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { EventLiveExplain, EventLiveExplains } from 'src/types/domain/event-live-explain.type';
import { EventId } from 'src/types/domain/event.type';
import { getCurrentSeason } from 'src/utils/common.util';

import { CachePrefix } from '../../configs/cache/cache.config';
import { redisClient } from '../../infrastructures/cache/client';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from '../../types/error.type';
import { mapCacheErrorToDomainError } from '../../utils/error.util';

const parseEventLiveExplain = (
  eventLiveExplainStr: string,
): E.Either<CacheError, EventLiveExplain> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(eventLiveExplainStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse event live JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as EventLiveExplain)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid EventLiveExplain structure',
            }),
          ),
    ),
  );

const parseEventLiveExplains = (
  eventLiveExplainMaps: Record<string, string>,
): E.Either<CacheError, EventLiveExplains> =>
  pipe(
    Object.values(eventLiveExplainMaps),
    (eventLiveExplainStrs) =>
      eventLiveExplainStrs.map((str) =>
        pipe(
          parseEventLiveExplain(str),
          E.getOrElse<CacheError, EventLiveExplain | null>(() => null),
        ),
      ),
    (parsedEventLiveExplains) =>
      parsedEventLiveExplains.filter(
        (eventLiveExplain): eventLiveExplain is EventLiveExplain => eventLiveExplain !== null,
      ),
    (validEventLiveExplains) => E.right(validEventLiveExplains),
  );

export const createEventLiveExplainCache = (
  config: EventLiveExplainCacheConfig = {
    keyPrefix: CachePrefix.LIVE_EXPLAIN,
    season: getCurrentSeason(),
  },
): EventLiveExplainCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getEventLiveExplains = (eventId: EventId): TE.TaskEither<DomainError, EventLiveExplains> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(`${baseKey}::${eventId}`),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all event live explains',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.filter((eventLiveExplainsMap) => Object.keys(eventLiveExplainsMap).length > 0),
          O.fold(
            () => TE.right([] as EventLiveExplains),
            (cachedEventLiveExplains): TE.TaskEither<DomainError, EventLiveExplains> =>
              pipe(
                parseEventLiveExplains(cachedEventLiveExplains),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
    );

  const setEventLiveExplains = (
    eventLiveExplains: EventLiveExplains,
  ): TE.TaskEither<DomainError, void> => {
    const eventId = eventLiveExplains[0].eventId;

    return pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(`${baseKey}::${eventId}`);
          if (eventLiveExplains.length > 0) {
            const items: Record<string, string> = {};
            eventLiveExplains.forEach((eventLiveExplain) => {
              items[eventLiveExplain.eventId.toString()] = JSON.stringify(eventLiveExplain);
            });
            multi.hset(`${baseKey}::${eventId}`, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to set all event live explains in cache hash',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );
  };

  return {
    getEventLiveExplains,
    setEventLiveExplains,
  };
};
