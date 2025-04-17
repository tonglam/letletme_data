import { TeamCache, TeamOperations, TeamRepository } from 'domains/team/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PrismaTeamCreate } from 'src/repositories/team/type';
import { TeamId } from 'src/types/domain/team.type';
import { createDomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createTeamOperations = (
  repository: TeamRepository,
  cache: TeamCache,
): TeamOperations => ({
  getAllTeams: () =>
    pipe(
      cache.getAllTeams(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Cache Error (getAllTeams): ${getErrorMessage(error)}`,
          cause: error instanceof Error ? error : undefined,
        }),
      ),
      TE.chain((cachedTeams) =>
        cachedTeams && cachedTeams.length > 0
          ? TE.right(cachedTeams)
          : pipe(
              repository.findAll(),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findAll): ${getErrorMessage(dbError)}`,
                  cause: dbError,
                }),
              ),
              TE.chainFirst((teams) =>
                teams && teams.length > 0
                  ? pipe(
                      cache.setAllTeams(teams),
                      TE.mapLeft((cacheError) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Cache Error (setAllTeams): ${getErrorMessage(cacheError)}`,
                          cause: cacheError instanceof Error ? cacheError : undefined,
                        }),
                      ),
                    )
                  : TE.right(undefined),
              ),
            ),
      ),
    ),

  getTeamById: (id: TeamId) =>
    pipe(
      cache.getTeam(id),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Cache Error (getTeamById): ${getErrorMessage(error)}`,
          cause: error instanceof Error ? error : undefined,
        }),
      ),
      TE.chain((cachedTeam) =>
        cachedTeam
          ? TE.right(cachedTeam)
          : pipe(
              repository.findById(id),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findById): ${getErrorMessage(dbError)}`,
                  cause: dbError,
                }),
              ),
            ),
      ),
    ),

  saveTeams: (teams: readonly PrismaTeamCreate[]) =>
    pipe(
      repository.saveBatch(teams),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
      TE.chainFirst((createdTeams) =>
        pipe(
          cache.setAllTeams(createdTeams),
          TE.mapLeft((cacheError) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Cache Error (setAllTeams): ${getErrorMessage(cacheError)}`,
              cause: cacheError instanceof Error ? cacheError : undefined,
            }),
          ),
        ),
      ),
    ),

  deleteAllTeams: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
      TE.chainFirst(() =>
        pipe(
          cache.deleteAllTeams(),
          TE.mapLeft((cacheError) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Cache Error (deleteAllTeams): ${getErrorMessage(cacheError)}`,
              cause: cacheError instanceof Error ? cacheError : undefined,
            }),
          ),
        ),
      ),
    ),
});
