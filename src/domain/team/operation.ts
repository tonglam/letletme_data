/**
 * Team Operations Module
 *
 * Implements domain operations for teams using functional programming patterns.
 * Handles team retrieval, creation, and cache management.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainErrorCode, createDomainError } from '../../types/error.type';
import {
  TeamCache,
  TeamId,
  TeamOperations as TeamOps,
  TeamRepository,
  Teams,
  toDomainTeam,
  toPrismaTeam,
} from './types';

/**
 * Creates team operations with repository and cache integration
 */
export const createTeamOperations = (repository: TeamRepository, cache: TeamCache): TeamOps => ({
  getAllTeams: () =>
    pipe(
      cache.getAllTeams(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get all teams: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedTeams) =>
        cachedTeams.length > 0
          ? TE.right(cachedTeams)
          : pipe(
              repository.findAll(),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch teams from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((teams) => teams.map(toDomainTeam)),
              TE.chainFirst((teams) =>
                pipe(
                  cache.cacheTeams(teams),
                  TE.mapLeft((error) =>
                    createDomainError({
                      code: DomainErrorCode.CACHE_ERROR,
                      message: `Failed to cache teams: ${error.message}`,
                      cause: error,
                    }),
                  ),
                ),
              ),
            ),
      ),
    ),

  getTeamById: (id: TeamId) =>
    pipe(
      cache.getTeam(id.toString()),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Failed to get team by id: ${error.message}`,
          cause: error,
        }),
      ),
      TE.chain((cachedTeam) =>
        cachedTeam
          ? TE.right(cachedTeam)
          : pipe(
              repository.findById(id),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Failed to fetch team from database: ${error.message}`,
                  cause: error,
                }),
              ),
              TE.map((team) => (team ? toDomainTeam(team) : null)),
              TE.chainFirst((team) =>
                team
                  ? pipe(
                      cache.cacheTeam(team),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Failed to cache team: ${error.message}`,
                          cause: error,
                        }),
                      ),
                    )
                  : TE.right(void 0),
              ),
            ),
      ),
    ),

  createTeams: (teams: Teams) =>
    pipe(
      repository.saveBatch(teams.map(toPrismaTeam)),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to create teams: ${error.message}`,
          cause: error,
        }),
      ),
      TE.map((savedTeams) => savedTeams.map(toDomainTeam)),
      TE.chainFirst((createdTeams) =>
        pipe(
          cache.cacheTeams(createdTeams),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Failed to cache created teams: ${error.message}`,
              cause: error,
            }),
          ),
        ),
      ),
    ),

  deleteAll: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `Failed to delete all teams: ${error.message}`,
          cause: error,
        }),
      ),
    ),
});
