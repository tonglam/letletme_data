import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError, createValidationError } from '../../infrastructure/http/common/errors';
import { Team, TeamId } from '../../types/teams.type';
import { TeamService } from './types';

/**
 * Team Service Workflows
 * Provides high-level operations combining multiple team service operations
 */
export const teamWorkflows = (teamService: TeamService) => {
  /**
   * Syncs teams from API to local database and verifies the sync
   * Existing data will be truncated and replaced with new data
   *
   * @returns TaskEither<APIError, readonly Team[]> - Success: synced teams, Error: APIError
   */
  const syncAndVerifyTeams = (): TE.TaskEither<APIError, readonly Team[]> =>
    pipe(
      teamService.syncTeams(),
      TE.mapLeft((error) => ({
        ...error,
        message: `Team sync failed: ${error.message}`,
      })),
      TE.chain(() =>
        pipe(
          teamService.getTeams(),
          TE.chain((teams) =>
            teams.length > 0
              ? TE.right(teams)
              : TE.left(createValidationError({ message: 'No teams found after sync' })),
          ),
        ),
      ),
    );

  /**
   * Gets team by ID with validation
   *
   * Validation checks:
   * 1. Validates teamId is valid
   * 2. Confirms team exists
   *
   * @param id - Team ID to fetch
   * @returns TaskEither<APIError, Team> - Success: team, Error: APIError
   */
  const getTeamWithValidation = (id: TeamId): TE.TaskEither<APIError, Team> =>
    pipe(
      TE.fromPredicate(
        () => id > 0,
        () => createValidationError({ message: 'Invalid team ID provided' }),
      )(id),
      TE.chain(() => teamService.getTeam(id)),
      TE.chain((team) =>
        team ? TE.right(team) : TE.left(createValidationError({ message: `Team ${id} not found` })),
      ),
    );

  return {
    syncAndVerifyTeams,
    getTeamWithValidation,
  } as const;
};

export type TeamWorkflows = ReturnType<typeof teamWorkflows>;
