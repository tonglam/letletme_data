import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainError, DomainErrorCode, createDomainError } from '../../../types/error.type';
import { Player, PlayerId } from '../../../types/player.type';
import { PlayerQueryOperations } from '../../../types/player/operations.type';
import { PlayerView, PlayerViews } from '../../../types/player/query.type';
import type { PlayerRepository } from '../../../types/player/repository.type';
import { Team, TeamId } from '../../../types/team.type';
import type { TeamRepository } from '../../../types/team/repository.type';
import { handleDomainError } from '../../../utils/error.util';
import { buildPlayerView, buildPlayerViews } from './converter';

export const createPlayerQueryOperations = (
  playerRepository: PlayerRepository,
  teamRepository: TeamRepository,
): PlayerQueryOperations => {
  const getPlayerWithTeam = (id: PlayerId): TE.TaskEither<DomainError, PlayerView | null> =>
    pipe(
      playerRepository.findById(id),
      TE.mapLeft(handleDomainError('Failed to fetch player')),
      TE.chain((player: Player | null) => {
        if (!player) return TE.right(null);
        return pipe(
          teamRepository.findById(player.teamId as TeamId),
          TE.mapLeft(handleDomainError('Failed to fetch team')),
          TE.chain((team: Team | null) => {
            if (!team) {
              return TE.left(
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `Team not found for player ${player.id}`,
                  cause: new Error(`Team ${player.teamId} not found`),
                }),
              );
            }
            return TE.right(buildPlayerView(player, team));
          }),
        );
      }),
    );

  const getAllPlayersWithTeams = (): TE.TaskEither<DomainError, PlayerViews> =>
    pipe(
      TE.Do,
      TE.bind('players', () =>
        pipe(playerRepository.findAll(), TE.mapLeft(handleDomainError('Failed to fetch players'))),
      ),
      TE.bind('teams', () =>
        pipe(teamRepository.findAll(), TE.mapLeft(handleDomainError('Failed to fetch teams'))),
      ),
      TE.map(({ players, teams }) => {
        const teamMap = new Map(teams.map((team) => [Number(team.id), team]));
        return buildPlayerViews(players, teamMap);
      }),
    );

  const getPlayersByTeam = (teamId: TeamId): TE.TaskEither<DomainError, PlayerViews> =>
    pipe(
      TE.Do,
      TE.bind('players', () =>
        pipe(
          playerRepository.findByTeamId(teamId),
          TE.mapLeft(handleDomainError('Failed to fetch players by team')),
        ),
      ),
      TE.bind('team', () =>
        pipe(
          teamRepository.findById(teamId),
          TE.mapLeft(handleDomainError('Failed to fetch team')),
        ),
      ),
      TE.chain(({ players, team }) => {
        if (!team) {
          return TE.left(
            createDomainError({
              code: DomainErrorCode.DATABASE_ERROR,
              message: `Team ${teamId} not found`,
              cause: new Error(`Team ${teamId} not found`),
            }),
          );
        }
        const teamMap = new Map([[Number(team.id), team]]);
        return TE.right(buildPlayerViews(players, teamMap));
      }),
    );

  return {
    getPlayerWithTeam,
    getAllPlayersWithTeams,
    getPlayersByTeam,
  };
};
