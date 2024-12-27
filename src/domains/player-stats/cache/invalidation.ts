import { APIError } from '@infrastructure/errors';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatsCache } from './cache';

export const createPlayerStatsInvalidation = (cache: PlayerStatsCache) => {
  const invalidatePlayerStats = (
    playerId: number,
    eventId: number,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => cache.getPlayerStats(playerId, eventId),
        (error) => error as APIError,
      ),
      TE.map(() => undefined),
    );

  const invalidateLatestPlayerStats = (playerId: number): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => cache.getLatestPlayerStats(playerId),
        (error) => error as APIError,
      ),
      TE.map(() => undefined),
    );

  return {
    invalidatePlayerStats,
    invalidateLatestPlayerStats,
  } as const;
};

export type PlayerStatsInvalidation = ReturnType<typeof createPlayerStatsInvalidation>;
