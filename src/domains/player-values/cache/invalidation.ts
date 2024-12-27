import { APIError } from '@infrastructure/errors';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerValuesCache } from './cache';

export const createPlayerValuesInvalidation = (cache: PlayerValuesCache) => {
  const invalidatePlayerValues = (
    playerId: number,
    eventId: number,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => cache.getPlayerValues(playerId, eventId),
        (error) => error as APIError,
      ),
      TE.map(() => undefined),
    );

  const invalidateLatestPlayerValue = (playerId: number): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => cache.getLatestPlayerValue(playerId),
        (error) => error as APIError,
      ),
      TE.map(() => undefined),
    );

  return {
    invalidatePlayerValues,
    invalidateLatestPlayerValue,
  } as const;
};

export type PlayerValuesInvalidation = ReturnType<typeof createPlayerValuesInvalidation>;
