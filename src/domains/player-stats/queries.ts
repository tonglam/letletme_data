import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { APIError } from '../../infrastructure/http/common/errors';
import {
  PlayerStat,
  PlayerStatRepository,
  PlayerStats,
  convertPrismaPlayerStats,
} from '../../types/player-stats.type';
import { PlayerId } from '../../types/players.type';

/**
 * Retrieves player stats history between two event IDs
 * @param repository - The player stats repository instance
 * @param playerId - The player ID to find stats for
 * @param startEventId - Start event ID (inclusive)
 * @param endEventId - End event ID (inclusive)
 * @returns TaskEither with array of player stats or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getStatsHistory = (
  repository: PlayerStatRepository,
  playerId: PlayerId,
  startEventId: number,
  endEventId: number,
): TE.TaskEither<APIError, PlayerStats> =>
  pipe(
    TE.sequenceArray(
      Array.from({ length: endEventId - startEventId + 1 }, (_, i) =>
        pipe(
          repository.findByEventId(startEventId + i),
          TE.map((stats) => stats.filter((s) => s.elementId === playerId)),
          TE.chain(convertPrismaPlayerStats),
        ),
      ),
    ),
    TE.map((stats) => stats.flat()),
  );

/**
 * Calculates points trend for a player between two event IDs
 * @param repository - The player stats repository instance
 * @param playerId - The player ID to analyze
 * @param startEventId - Start event ID (inclusive)
 * @param endEventId - End event ID (inclusive)
 * @returns TaskEither with points trend analysis or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getPointsTrend = (
  repository: PlayerStatRepository,
  playerId: PlayerId,
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
    getStatsHistory(repository, playerId, startEventId, endEventId),
    TE.map((stats) => {
      const points = stats.map((stat) => stat.bps ?? 0);
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

/**
 * Finds the best performance of a player between two event IDs
 * @param repository - The player stats repository instance
 * @param playerId - The player ID to analyze
 * @param startEventId - Start event ID (inclusive)
 * @param endEventId - End event ID (inclusive)
 * @returns TaskEither with best performance stats or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getBestPerformance = (
  repository: PlayerStatRepository,
  playerId: PlayerId,
  startEventId: number,
  endEventId: number,
): TE.TaskEither<APIError, PlayerStat | null> =>
  pipe(
    getStatsHistory(repository, playerId, startEventId, endEventId),
    TE.map((stats) =>
      stats.reduce(
        (best, current) => (!best || (current.bps ?? 0) > (best.bps ?? 0) ? current : best),
        null as PlayerStat | null,
      ),
    ),
  );

/**
 * Finds the worst performance of a player between two event IDs
 * @param repository - The player stats repository instance
 * @param playerId - The player ID to analyze
 * @param startEventId - Start event ID (inclusive)
 * @param endEventId - End event ID (inclusive)
 * @returns TaskEither with worst performance stats or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getWorstPerformance = (
  repository: PlayerStatRepository,
  playerId: PlayerId,
  startEventId: number,
  endEventId: number,
): TE.TaskEither<APIError, PlayerStat | null> =>
  pipe(
    getStatsHistory(repository, playerId, startEventId, endEventId),
    TE.map((stats) =>
      stats.reduce(
        (worst, current) => (!worst || (current.bps ?? 0) < (worst.bps ?? 0) ? current : worst),
        null as PlayerStat | null,
      ),
    ),
  );
