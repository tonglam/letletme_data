import { APIError } from '@infrastructure/errors';
import { PlayerStat } from '@types/playerStats.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatsOperations } from './operations';

export const createPlayerStatsQueries = (operations: PlayerStatsOperations) => {
  // Aggregation queries
  const getStatsHistory = (
    playerId: number,
    startEventId: number,
    endEventId: number,
  ): TE.TaskEither<APIError, ReadonlyArray<PlayerStat>> =>
    pipe(
      TE.sequenceArray(
        Array.from({ length: endEventId - startEventId + 1 }, (_, i) =>
          operations.getPlayerStats(playerId, startEventId + i),
        ),
      ),
      TE.map((stats) => stats.flat()),
    );

  const getPointsTrend = (
    playerId: number,
    startEventId: number,
    endEventId: number,
  ): TE.TaskEither<
    APIError,
    {
      readonly totalPoints: number;
      readonly averagePoints: number;
      readonly highestPoints: number;
      readonly lowestPoints: number;
    }
  > =>
    pipe(
      getStatsHistory(playerId, startEventId, endEventId),
      TE.map((stats) => {
        const points = stats.map((stat) => stat.totalPoints);
        const totalPoints = points.reduce((sum, points) => sum + points, 0);
        const averagePoints = totalPoints / points.length;
        const highestPoints = Math.max(...points);
        const lowestPoints = Math.min(...points);

        return {
          totalPoints,
          averagePoints,
          highestPoints,
          lowestPoints,
        };
      }),
    );

  const getBestPerformance = (
    playerId: number,
    startEventId: number,
    endEventId: number,
  ): TE.TaskEither<APIError, PlayerStat | null> =>
    pipe(
      getStatsHistory(playerId, startEventId, endEventId),
      TE.map((stats) =>
        stats.reduce(
          (best, current) => (!best || current.totalPoints > best.totalPoints ? current : best),
          null as PlayerStat | null,
        ),
      ),
    );

  const getWorstPerformance = (
    playerId: number,
    startEventId: number,
    endEventId: number,
  ): TE.TaskEither<APIError, PlayerStat | null> =>
    pipe(
      getStatsHistory(playerId, startEventId, endEventId),
      TE.map((stats) =>
        stats.reduce(
          (worst, current) => (!worst || current.totalPoints < worst.totalPoints ? current : worst),
          null as PlayerStat | null,
        ),
      ),
    );

  return {
    getStatsHistory,
    getPointsTrend,
    getBestPerformance,
    getWorstPerformance,
  } as const;
};

export type PlayerStatsQueries = ReturnType<typeof createPlayerStatsQueries>;
