import { CachePrefix, DefaultTTL } from 'configs/cache/cache.config';
import { TeamCache, TeamCacheConfig } from 'domains/team/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { redisClient } from 'infrastructures/cache/client';
import { Team, Teams } from 'types/domain/team.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'types/error.type';
import { getCurrentSeason } from 'utils/common.util';
import { mapCacheErrorToDomainError } from 'utils/error.util';

const parseTeam = (teamStr: string): E.Either<CacheError, Team> =>
  pipe(
    E.tryCatch(
      () => JSON.parse(teamStr),
      (error) =>
        createCacheError({
          code: CacheErrorCode.DESERIALIZATION_ERROR,
          message: 'Failed to parse team JSON',
          cause: error as Error,
        }),
    ),
    E.chain((parsed) =>
      parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number'
        ? E.right(parsed as Team)
        : E.left(
            createCacheError({
              code: CacheErrorCode.DESERIALIZATION_ERROR,
              message: 'Parsed object is not a valid Team structure',
            }),
          ),
    ),
  );

const parseTeams = (teamMaps: Record<string, string>): E.Either<CacheError, Teams> =>
  pipe(
    Object.values(teamMaps),
    (teamStrs) =>
      teamStrs.map((str) =>
        pipe(
          parseTeam(str),
          E.getOrElse<CacheError, Team | null>(() => null),
        ),
      ),
    (parsedTeams) => parsedTeams.filter((team): team is Team => team !== null),
    (validTeams) => E.right(validTeams),
  );

export const createTeamCache = (
  config: TeamCacheConfig = {
    keyPrefix: CachePrefix.TEAM,
    season: getCurrentSeason(),
    ttlSeconds: DefaultTTL.TEAM,
  },
): TeamCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getAllTeams = (): TE.TaskEither<DomainError, Teams> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hgetall(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get all teams',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
      TE.chain(
        flow(
          O.fromNullable,
          O.filter((teamsMap) => Object.keys(teamsMap).length > 0),
          O.fold(
            () => TE.right([] as Teams),
            (cachedTeams): TE.TaskEither<DomainError, Teams> =>
              pipe(parseTeams(cachedTeams), TE.fromEither, TE.mapLeft(mapCacheErrorToDomainError)),
          ),
        ),
      ),
    );

  const setAllTeams = (teams: Teams): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          const multi = redisClient.multi();
          multi.del(baseKey);
          if (teams.length > 0) {
            const items: Record<string, string> = {};
            teams.forEach((team) => {
              items[team.id.toString()] = JSON.stringify(team);
            });
            multi.hset(baseKey, items);
          }
          await multi.exec();
        },
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to set all teams',
            cause: error as Error,
          }),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getAllTeams,
    setAllTeams,
  };
};
