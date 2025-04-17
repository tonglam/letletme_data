import { TeamCache, TeamCacheConfig, TeamRepository } from 'domains/team/types';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { redisClient } from 'src/infrastructures/cache/client';
import { getCurrentSeason } from 'src/types/base.type';
import { Team, TeamId, Teams } from 'src/types/domain/team.type';
import { CacheError, CacheErrorCode, createCacheError, DomainError } from 'src/types/error.type';
import { mapCacheErrorToDomainError, mapRepositoryErrorToCacheError } from 'src/utils/error.util';

const parseTeam = (teamStr: string): E.Either<CacheError, Team | null> =>
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
        : E.right(null),
    ),
  );

const parseTeams = (teams: Record<string, string>): E.Either<CacheError, Team[]> =>
  pipe(
    Object.values(teams),
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
  repository: TeamRepository,
  config: TeamCacheConfig = {
    keyPrefix: CachePrefix.TEAM,
    season: getCurrentSeason(),
  },
): TeamCache => {
  const { keyPrefix, season } = config;
  const baseKey = `${keyPrefix}::${season}`;

  const getTeam = (id: TeamId): TE.TaskEither<DomainError, Team | null> =>
    pipe(
      TE.tryCatch(
        () => redisClient.hget(baseKey, id.toString()),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Read Error: Failed to get team',
            cause: error as Error,
          }),
      ),
      TE.chain(
        flow(
          O.fromNullable,
          O.fold(
            () =>
              pipe(
                repository.findById(id),
                TE.mapLeft(mapRepositoryErrorToCacheError('Repository Error: Failed to get team')),
              ),
            (teamStr) => pipe(parseTeam(teamStr), TE.fromEither),
          ),
        ),
      ),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  const getAllTeams = (): TE.TaskEither<DomainError, Teams | null> =>
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
            () =>
              pipe(
                repository.findAll(),
                TE.mapLeft(
                  mapRepositoryErrorToCacheError('Repository Error: Failed to get all teams'),
                ),
                TE.mapLeft(mapCacheErrorToDomainError),
                TE.chainFirst((teams) => setAllTeams(teams)),
              ),
            (cachedTeams) =>
              pipe(parseTeams(cachedTeams), TE.fromEither, TE.mapLeft(mapCacheErrorToDomainError)),
          ),
        ),
      ),
      TE.map((teams) => (teams.length > 0 ? teams : null)),
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

  const deleteAllTeams = (): TE.TaskEither<DomainError, void> =>
    pipe(
      TE.tryCatch(
        () => redisClient.del(baseKey),
        (error: unknown) =>
          createCacheError({
            code: CacheErrorCode.OPERATION_ERROR,
            message: 'Cache Write Error: Failed to delete all teams',
            cause: error as Error,
          }),
      ),
      TE.map(() => undefined),
      TE.mapLeft(mapCacheErrorToDomainError),
    );

  return {
    getTeam,
    getAllTeams,
    setAllTeams,
    deleteAllTeams,
  };
};
