import { EventFixtureCache } from 'domains/event-fixture/types';
import { EventFixtureCacheConfig } from 'domains/event-fixture/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { EventFixture, EventFixtures } from 'src/types/domain/event-fixture.type';
import { EventId } from 'src/types/domain/event.type';
import { getCurrentSeason } from 'src/utils/common.util';

import { CachePrefix, DefaultTTL } from '../../configs/cache/cache.config';
import { redisClient } from '../../infrastructures/cache/client';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from '../../types/error.type';
import { mapCacheErrorToDomainError } from '../../utils/error.util';

const parseEventFixture = (eventFixtureStr: string): E.Either<CacheError, EventFixture> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(eventFixtureStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse event fixture JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as EventFixture)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid EventFixture structure',
            }),
          ),
    ),
  );

const parseEventFixtures = (
  eventFixtureMaps: Record<string, string>,
): E.Either<CacheError, EventFixtures> =>
  pipe(
    Object.values(eventFixtureMaps),
    (eventFixtureStrs) =>
      eventFixtureStrs.map((str) =>
        pipe(
          parseEventFixture(str),
          E.getOrElse<CacheError, EventFixture | null>(() => null),
        ),
      ),
    (parsedEventFixtures) =>
      parsedEventFixtures.filter(
        (eventFixture): eventFixture is EventFixture => eventFixture !== null,
      ),
    (validEventFixtures) => E.right(validEventFixtures),
  );

export const createEventFixtureCache = (
  config: EventFixtureCacheConfig = {
    keyPrefix: CachePrefix.FIXTURE,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.FIXTURE,
  },
): EventFixtureCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getEventFixtures = (eventId: EventId): TE.TaskEither<DomainError, EventFixtures> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(`${baseKey}::${eventId}`),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all event fixtures',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.filter((eventFixturesMap) => Object.keys(eventFixturesMap).length > 0),
          O.fold(
            () => TE.right([] as EventFixtures),
            (cachedEventFixtures): TE.TaskEither<DomainError, EventFixtures> =>
              pipe(
                parseEventFixtures(cachedEventFixtures),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
    );

  const getAllEventFixtures = (): TE.TaskEither<DomainError, EventFixtures> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(`${baseKey}`),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all event fixtures',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.filter((eventFixturesMap) => Object.keys(eventFixturesMap).length > 0),
          O.fold(
            () => TE.right([] as EventFixtures),
            (cachedEventFixtures): TE.TaskEither<DomainError, EventFixtures> =>
              pipe(
                parseEventFixtures(cachedEventFixtures),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
    );

  const setEventFixtures = (eventFixtures: EventFixtures): TE.TaskEither<DomainError, void> => {
    const eventId = eventFixtures[0].eventId;

    return pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(`${baseKey}::${eventId}`);
          if (eventFixtures.length > 0) {
            const items: Record<string, string> = {};
            eventFixtures.forEach((eventFixture) => {
              items[eventFixture.id.toString()] = JSON.stringify(eventFixture);
            });
            multi.hset(`${baseKey}::${eventId}`, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to set all event fixtures in cache hash',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );
  };

  return {
    getEventFixtures,
    getAllEventFixtures,
    setEventFixtures,
  };
};
