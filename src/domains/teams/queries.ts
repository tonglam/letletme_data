import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError, createValidationError } from '../../infrastructure/api/common/errors';
import { PrismaTeam, TeamRepository, validateTeamId } from '../../types/teams.type';

/**
 * Retrieves all teams from the repository
 * @param repository - The teams repository instance
 * @returns TaskEither with array of teams or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getAllTeams = (repository: TeamRepository): TE.TaskEither<APIError, PrismaTeam[]> =>
  repository.findAll();

/**
 * Retrieves a specific team by its ID
 * @param repository - The teams repository instance
 * @param id - The team ID to find
 * @returns TaskEither with team or null if not found
 * @throws APIError with VALIDATION_ERROR code if ID is invalid
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getTeamById = (
  repository: TeamRepository,
  id: number,
): TE.TaskEither<APIError, PrismaTeam | null> =>
  pipe(
    validateTeamId(id),
    E.mapLeft((message) => createValidationError({ message })),
    TE.fromEither,
    TE.chain(repository.findById),
  );

/**
 * Finds teams by their position range
 * @param repository - The teams repository instance
 * @param startPosition - Start position (inclusive)
 * @param endPosition - End position (inclusive)
 * @returns TaskEither with teams in position range or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getTeamsByPositionRange = (
  repository: TeamRepository,
  startPosition: number,
  endPosition: number,
): TE.TaskEither<APIError, PrismaTeam[]> =>
  pipe(
    repository.findAll(),
    TE.map((teams) =>
      pipe(
        teams,
        A.filter((team) => team.position >= startPosition && team.position <= endPosition),
      ),
    ),
  );

/**
 * Saves a team to the repository
 * @param repository - The teams repository instance
 * @param team - The team to save
 * @returns TaskEither with saved team or error
 * @throws APIError with DB_ERROR code if database operation fails
 */
export const saveTeam = (
  repository: TeamRepository,
  team: PrismaTeam,
): TE.TaskEither<APIError, PrismaTeam> => repository.save(team);

/**
 * Saves multiple teams to the repository in a transaction
 * @param repository - The teams repository instance
 * @param teams - Array of teams to save
 * @returns TaskEither with saved teams or error
 * @throws APIError with DB_ERROR code if database operation fails
 */
export const saveTeams = (
  repository: TeamRepository,
  teams: PrismaTeam[],
): TE.TaskEither<APIError, PrismaTeam[]> => repository.saveBatch(teams);
