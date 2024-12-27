import { APIError, createInternalServerError } from '@infrastructure/errors';
import { PlayerValue, PlayerValuesResponse } from '@types/playerValues.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValuesCache } from './cache';
import { PlayerValuesInvalidation } from './cache/invalidation';
import { PlayerValuesRepository } from './repository';

export const createPlayerValuesOperations = (
  repository: PlayerValuesRepository,
  cache: PlayerValuesCache,
  cacheInvalidation: PlayerValuesInvalidation,
) => {
  // Core processing functions
  const processValues = (
    response: PlayerValuesResponse,
    eventId: number,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      repository.processValuesResponse(response, eventId),
      TE.chain(() => cacheInvalidation.invalidatePlayerValues(eventId, eventId)),
      TE.mapLeft((error) => createInternalServerError({ message: error.message })),
    );

  // Query operations
  const getPlayerValues = (
    playerId: number,
    eventId: number,
  ): TE.TaskEither<APIError, ReadonlyArray<PlayerValue>> =>
    pipe(
      cache.getPlayerValues(playerId, eventId),
      TE.orElse(() =>
        pipe(
          repository.findByPlayerId(playerId, eventId),
          TE.chain((values) =>
            pipe(
              cache.setPlayerValues(playerId, eventId, values),
              TE.map(() => values),
            ),
          ),
        ),
      ),
    );

  const getLatestPlayerValue = (playerId: number): TE.TaskEither<APIError, PlayerValue | null> =>
    pipe(
      cache.getLatestPlayerValue(playerId),
      TE.orElse(() =>
        pipe(
          repository.findLatestByPlayerId(playerId),
          TE.chain((value) =>
            value
              ? pipe(
                  cache.setLatestPlayerValue(playerId, value),
                  TE.map(() => value),
                )
              : TE.right(null),
          ),
        ),
      ),
    );

  return {
    processValues,
    getPlayerValues,
    getLatestPlayerValue,
  } as const;
};

export type PlayerValuesOperations = ReturnType<typeof createPlayerValuesOperations>;
