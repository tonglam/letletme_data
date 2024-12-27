import { Player } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { APIError } from '../../infrastructure/errors';
import { PlayerOperations } from './operations';

export const createPlayerQueries = (operations: PlayerOperations) => {
  // Aggregation queries
  const getPlayerHistory = (
    playerId: number,
    startEventId: number,
    endEventId: number,
  ): TE.TaskEither<APIError, ReadonlyArray<Player>> =>
    pipe(
      TE.sequenceArray(
        Array.from({ length: endEventId - startEventId + 1 }).map(() =>
          operations.getById(playerId),
        ),
      ),
      TE.map((players) => players.filter((p): p is Player => p !== null)),
    );

  const getTeamPlayers = (teamId: number): TE.TaskEither<APIError, ReadonlyArray<Player>> =>
    pipe(
      operations.getAll(),
      TE.map((players) => players.filter((p) => p.teamId === teamId)),
    );

  const getPlayersByPosition = (position: number): TE.TaskEither<APIError, ReadonlyArray<Player>> =>
    pipe(
      operations.getAll(),
      TE.map((players) => players.filter((p) => p.elementType === position)),
    );

  const getTopPerformers = (limit: number = 10): TE.TaskEither<APIError, ReadonlyArray<Player>> =>
    pipe(
      operations.getAll(),
      TE.map((players) =>
        [...players].sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0)).slice(0, limit),
      ),
    );

  const getMostValuablePlayers = (
    limit: number = 10,
  ): TE.TaskEither<APIError, ReadonlyArray<Player>> =>
    pipe(
      operations.getAll(),
      TE.map((players) =>
        [...players].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, limit),
      ),
    );

  const getPlayersBySearchTerm = (
    searchTerm: string,
  ): TE.TaskEither<APIError, ReadonlyArray<Player>> =>
    pipe(
      operations.getAll(),
      TE.map((players) =>
        players.filter(
          (p) =>
            p.webName.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.firstName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.secondName?.toLowerCase().includes(searchTerm.toLowerCase()),
        ),
      ),
    );

  return {
    getPlayerHistory,
    getTeamPlayers,
    getPlayersByPosition,
    getTopPerformers,
    getMostValuablePlayers,
    getPlayersBySearchTerm,
  } as const;
};

export type PlayerQueries = ReturnType<typeof createPlayerQueries>;
