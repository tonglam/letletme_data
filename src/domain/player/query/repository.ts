import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { TeamService } from '../../../service/team/types';
import { ElementType } from '../../../types/base.type';
import { DomainError, DomainErrorCode, createDomainError } from '../../../types/error.type';
import { PlayerId, toDomainPlayer } from '../../../types/player/base.type';
import { PlayerQuery, PlayerView, PlayerViews } from '../../../types/player/query.type';
import { TeamId } from '../../../types/team.type';
import { buildPlayerView, buildPlayerViews } from './converter';

export const createPlayerQueryRepository = (
  prisma: PrismaClient,
  teamService: TeamService,
): PlayerQuery => ({
  getPlayer: (id: PlayerId): TE.TaskEither<DomainError, PlayerView | null> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.findUnique({
            where: { element: Number(id) },
          }),
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to fetch player from database',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain((player) =>
        player
          ? pipe(
              teamService.getTeam(player.teamId as TeamId),
              TE.mapLeft((error) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: 'Failed to fetch team data',
                  cause: error.cause,
                }),
              ),
              TE.chain((team) =>
                team
                  ? TE.right(buildPlayerView(toDomainPlayer(player), team))
                  : TE.left(
                      createDomainError({
                        code: DomainErrorCode.DATABASE_ERROR,
                        message: `Team ${player.teamId} not found for player ${player.element}`,
                      }),
                    ),
              ),
            )
          : TE.right(null),
      ),
    ),

  getAllPlayers: (): TE.TaskEither<DomainError, PlayerViews> =>
    pipe(
      TE.tryCatch(
        () => prisma.player.findMany(),
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to fetch players from database',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain((players) =>
        pipe(
          teamService.getTeams(),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.DATABASE_ERROR,
              message: 'Failed to fetch teams data',
              cause: error.cause,
            }),
          ),
          TE.map((teams) =>
            buildPlayerViews(
              players.map(toDomainPlayer),
              new Map(teams.map((team) => [team.id, team])),
            ),
          ),
        ),
      ),
    ),

  getPlayersByTeam: (teamId: number): TE.TaskEither<DomainError, PlayerViews> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.findMany({
            where: { teamId },
          }),
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to fetch players by team from database',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain((players) =>
        pipe(
          teamService.getTeams(),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.DATABASE_ERROR,
              message: 'Failed to fetch teams data',
              cause: error.cause,
            }),
          ),
          TE.map((teams) =>
            buildPlayerViews(
              players.map(toDomainPlayer),
              new Map(teams.map((team) => [team.id, team])),
            ),
          ),
        ),
      ),
    ),

  getPlayersByElementType: (elementType: string): TE.TaskEither<DomainError, PlayerViews> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.findMany({
            where: { elementType: ElementType[elementType as keyof typeof ElementType] },
          }),
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to fetch players by element type from database',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain((players) =>
        pipe(
          teamService.getTeams(),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.DATABASE_ERROR,
              message: 'Failed to fetch teams data',
              cause: error.cause,
            }),
          ),
          TE.map((teams) =>
            buildPlayerViews(
              players.map(toDomainPlayer),
              new Map(teams.map((team) => [team.id, team])),
            ),
          ),
        ),
      ),
    ),
});
