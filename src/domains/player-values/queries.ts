import { APIError } from '@infrastructure/errors';
import { PlayerValue } from '@types/playerValues.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValuesOperations } from './operations';

export const createPlayerValuesQueries = (operations: PlayerValuesOperations) => {
  // Aggregation queries
  const getValueHistory = (
    playerId: number,
    startEventId: number,
    endEventId: number,
  ): TE.TaskEither<APIError, ReadonlyArray<PlayerValue>> =>
    pipe(
      TE.sequenceArray(
        Array.from({ length: endEventId - startEventId + 1 }, (_, i) =>
          operations.getPlayerValues(playerId, startEventId + i),
        ),
      ),
      TE.map((values) => values.flat()),
    );

  const getValueTrend = (
    playerId: number,
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
      getValueHistory(playerId, startEventId, endEventId),
      TE.map((values) => {
        const startValue = values[0]?.value || 0;
        const endValue = values[values.length - 1]?.value || 0;
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

  const getHighestValue = (
    playerId: number,
    startEventId: number,
    endEventId: number,
  ): TE.TaskEither<APIError, PlayerValue | null> =>
    pipe(
      getValueHistory(playerId, startEventId, endEventId),
      TE.map((values) =>
        values.reduce(
          (max, current) => (!max || current.value > max.value ? current : max),
          null as PlayerValue | null,
        ),
      ),
    );

  const getLowestValue = (
    playerId: number,
    startEventId: number,
    endEventId: number,
  ): TE.TaskEither<APIError, PlayerValue | null> =>
    pipe(
      getValueHistory(playerId, startEventId, endEventId),
      TE.map((values) =>
        values.reduce(
          (min, current) => (!min || current.value < min.value ? current : min),
          null as PlayerValue | null,
        ),
      ),
    );

  return {
    getValueHistory,
    getValueTrend,
    getHighestValue,
    getLowestValue,
  } as const;
};

export type PlayerValuesQueries = ReturnType<typeof createPlayerValuesQueries>;
