import {
  EventOverallResultCache,
  EventOverallResultCacheConfig,
} from 'domain/event-overall-result/types';

import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { redisClient } from 'infrastructure/cache/client';
import { EventOverallResult, EventOverallResults } from 'types/domain/event-overall-result.type';
import { EventId } from 'types/domain/event.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'types/error.type';
import { getCurrentSeason } from 'utils/common.util';
import { mapCacheErrorToDomainError } from 'utils/error.util';

const parseEventOverallResult = (
  eventOverallResultStr: string,
): E.Either<CacheError, EventOverallResult> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(eventOverallResultStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse event overall result JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed &&
      typeof parsed === 'object' &&
      'eventId' in parsed &&
      typeof parsed.eventId === 'number'
        ? E.right(parsed as EventOverallResult)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid EventOverallResult structure',
            }),
          ),
    ),
  );

export const createEventOverallResultCache = (
  config: EventOverallResultCacheConfig = {
    keyPrefix: CachePrefix.OVERALL_RESULT,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.OVERALL_RESULT,
  },
): EventOverallResultCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getEventOverallResult = (
    eventId: EventId,
  ): TE.TaskEither<DomainError, EventOverallResult> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, eventId.toString()),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get event overall result',
            cause: error as Error,
          }),
      ),
      TE.chainW((eventOverallResultStr) =>
        eventOverallResultStr
          ? TE.fromEither(parseEventOverallResult(eventOverallResultStr))
          : TE.left(
              createCacheError({
                code: CacheErrorCode.NOT_FOUND,
                message: 'Event overall result not found in cache',
              }),
            ),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  const setAllEventOverallResults = (
    eventOverallResults: EventOverallResults,
  ): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(baseKey);
          if (eventOverallResults.length > 0) {
            const items: Record<string, string> = {};
            eventOverallResults.forEach((eventOverallResult) => {
              items[eventOverallResult.eventId.toString()] = JSON.stringify(eventOverallResult);
            });
            multi.hset(baseKey, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to set all event overall results in cache hash',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getEventOverallResult,
    setAllEventOverallResults,
  };
};
