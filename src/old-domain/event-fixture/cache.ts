import { EventFixtureCache } from 'domain/event-fixture/types';
import { EventFixtureCacheConfig } from 'domain/event-fixture/types';

import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { redisClient } from 'infrastructure/cache/client';
import { EventFixture, EventFixtures } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { CacheError, CacheErrorCode, createCacheError } from 'types/error.type';
import { getCurrentSeason } from 'utils/common.util';

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
    keyPrefix: CachePrefix.EVENT_FIXTURE,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.EVENT_FIXTURE,
  },
): EventFixtureCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getEventFixtures = (eventId: EventId): TE.TaskEither<CacheError, EventFixtures> =>
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
      TE.chain(
        flow(
          O.fromNullable,
          O.filter((eventFixturesMap) => Object.keys(eventFixturesMap).length > 0),
          O.fold(
            () => TE.right([] as EventFixtures),
            (cachedEventFixtures): TE.TaskEither<CacheError, EventFixtures> =>
              pipe(parseEventFixtures(cachedEventFixtures), TE.fromEither),
          ),
        ),
      ),
    );

  const getAllEventFixtures = (): TE.TaskEither<CacheError, EventFixtures> => {
    const pattern = `${baseKey}::*`;
    let cursor = '0';
    let allFixtures: EventFixtures = [];

    const scanAndFetch: TE.TaskEither<CacheError, void> = TE.tryCatch(
      async () => {
        do {
          const scanResult = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = scanResult[0];
          const keys = scanResult[1];

          if (keys.length > 0) {
            for (const key of keys) {
              const fixturesMap = await redisClient.hgetall(key);
              if (fixturesMap && Object.keys(fixturesMap).length > 0) {
                const parsedResult = parseEventFixtures(fixturesMap);
                if (E.isRight(parsedResult)) {
                  allFixtures = allFixtures.concat(parsedResult.right);
                }
              }
            }
          }
        } while (cursor !== '0');
      },
      (error: unknown) =>
        createCacheError({
          code: CacheErrorCode.OPERATION_ERROR,
          message: `Cache Read Error: Failed during SCAN/HGETALL for pattern ${pattern}`,
          cause: error as Error,
        }),
    );

    return pipe(
      scanAndFetch,
      TE.map(() => allFixtures),
    );
  };

  const setEventFixtures = (eventFixtures: EventFixtures): TE.TaskEither<CacheError, void> => {
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
    );
  };

  return {
    getEventFixtures,
    getAllEventFixtures,
    setEventFixtures,
  };
};
