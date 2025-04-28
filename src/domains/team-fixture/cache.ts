import { CachePrefix, DefaultTTL } from 'configs/cache/cache.config';
import { TeamFixtureCache } from 'domains/team-fixture/types';
import { TeamFixtureCacheConfig } from 'domains/team-fixture/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { redisClient } from 'infrastructures/cache/client';
import { TeamFixture, TeamFixtures } from 'types/domain/team-fixture.type';
import { TeamId } from 'types/domain/team.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'types/error.type';
import { getCurrentSeason } from 'utils/common.util';
import { mapCacheErrorToDomainError } from 'utils/error.util';

const parseTeamFixture = (teamFixtureStr: string): E.Either<CacheError, TeamFixture> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(teamFixtureStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse team fixture JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as TeamFixture)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid TeamFixture structure',
            }),
          ),
    ),
  );

const parseTeamFixtures = (
  teamFixtureMaps: Record<string, string>,
): E.Either<CacheError, TeamFixtures> =>
  pipe(
    Object.values(teamFixtureMaps),
    (teamFixtureStrs) =>
      teamFixtureStrs.map((str) =>
        pipe(
          parseTeamFixture(str),
          E.getOrElse<CacheError, TeamFixture | null>(() => null),
        ),
      ),
    (parsedTeamFixtures) =>
      parsedTeamFixtures.filter((teamFixture): teamFixture is TeamFixture => teamFixture !== null),
    (validTeamFixtures) => E.right(validTeamFixtures),
  );

export const createTeamFixtureCache = (
  config: TeamFixtureCacheConfig = {
    keyPrefix: CachePrefix.FIXTURE,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.FIXTURE,
  },
): TeamFixtureCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getFixturesByTeamId = (teamId: TeamId): TE.TaskEither<DomainError, TeamFixtures> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(`${baseKey}::${teamId}`),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all team fixtures',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.filter((eventFixturesMap) => Object.keys(eventFixturesMap).length > 0),
          O.fold(
            () => TE.right([] as TeamFixtures),
            (cachedTeamFixtures): TE.TaskEither<DomainError, TeamFixtures> =>
              pipe(
                parseTeamFixtures(cachedTeamFixtures),
                TE.fromEither,
                TE.mapLeft(mapCacheErrorToDomainError),
              ),
          ),
        ),
      ),
    );

  const setFixturesByTeamId = (teamFixtures: TeamFixtures): TE.TaskEither<DomainError, void> => {
    const teamId = teamFixtures[0].teamId;

    return pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(`${baseKey}::${teamId}`);
          if (teamFixtures.length > 0) {
            const items: Record<string, string> = {};
            teamFixtures.forEach((teamFixture) => {
              items[teamFixture.eventId.toString()] = JSON.stringify(teamFixture);
            });
            multi.hset(`${baseKey}::${teamId}`, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Failed to set all team fixtures in cache hash',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );
  };

  return {
    getFixturesByTeamId,
    setFixturesByTeamId,
  };
};
