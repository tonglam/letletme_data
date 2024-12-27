import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { APIError } from '../../infrastructure/http/common/errors';
import {
  PlayerValue,
  PlayerValueRepository,
  PlayerValues,
  convertPrismaPlayerValues,
} from '../../types/player-values.type';
import { PlayerId } from '../../types/players.type';

/**
 * Retrieves player value history between two event IDs
 * @param repository - The player value repository instance
 * @param playerId - The player ID to find values for
 * @param startEventId - Start event ID (inclusive)
 * @param endEventId - End event ID (inclusive)
 * @returns TaskEither with array of player values or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getValueHistory = (
  repository: PlayerValueRepository,
  playerId: PlayerId,
  startEventId: number,
  endEventId: number,
): TE.TaskEither<APIError, PlayerValues> =>
  pipe(
    TE.sequenceArray(
      Array.from({ length: endEventId - startEventId + 1 }, (_, i) =>
        pipe(
          repository.findByEventId(startEventId + i),
          TE.map((values) => values.filter((v) => v.elementId === playerId)),
          TE.chain(convertPrismaPlayerValues),
        ),
      ),
    ),
    TE.map((values) => values.flat()),
  );

/**
 * Calculates value trend for a player between two event IDs
 * @param repository - The player value repository instance
 * @param playerId - The player ID to analyze
 * @param startEventId - Start event ID (inclusive)
 * @param endEventId - End event ID (inclusive)
 * @returns TaskEither with value trend analysis or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getValueTrend = (
  repository: PlayerValueRepository,
  playerId: PlayerId,
  startEventId: number,
  endEventId: number,
): TE.TaskEither<
  APIError,
  {
    readonly startValue: number;
    readonly endValue: number;
    readonly difference: number;
    readonly percentageChange: number;
  }
> =>
  pipe(
    getValueHistory(repository, playerId, startEventId, endEventId),
    TE.map((values) => {
      const startValue = values[0]?.value ?? 0;
      const endValue = values[values.length - 1]?.value ?? 0;
      const difference = endValue - startValue;
      const percentageChange = startValue === 0 ? 0 : (difference / startValue) * 100;

      return {
        startValue,
        endValue,
        difference,
        percentageChange,
      };
    }),
  );

/**
 * Finds the highest value of a player between two event IDs
 * @param repository - The player value repository instance
 * @param playerId - The player ID to analyze
 * @param startEventId - Start event ID (inclusive)
 * @param endEventId - End event ID (inclusive)
 * @returns TaskEither with highest value record or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getHighestValue = (
  repository: PlayerValueRepository,
  playerId: PlayerId,
  startEventId: number,
  endEventId: number,
): TE.TaskEither<APIError, PlayerValue | null> =>
  pipe(
    getValueHistory(repository, playerId, startEventId, endEventId),
    TE.map((values) =>
      values.reduce(
        (max, current) => (!max || current.value > max.value ? current : max),
        null as PlayerValue | null,
      ),
    ),
  );

/**
 * Finds the lowest value of a player between two event IDs
 * @param repository - The player value repository instance
 * @param playerId - The player ID to analyze
 * @param startEventId - Start event ID (inclusive)
 * @param endEventId - End event ID (inclusive)
 * @returns TaskEither with lowest value record or error
 * @throws APIError with DB_ERROR code if database query fails
 */
export const getLowestValue = (
  repository: PlayerValueRepository,
  playerId: PlayerId,
  startEventId: number,
  endEventId: number,
): TE.TaskEither<APIError, PlayerValue | null> =>
  pipe(
    getValueHistory(repository, playerId, startEventId, endEventId),
    TE.map((values) =>
      values.reduce(
        (min, current) => (!min || current.value < min.value ? current : min),
        null as PlayerValue | null,
      ),
    ),
  );
