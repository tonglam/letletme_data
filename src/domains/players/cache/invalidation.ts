import { APIError } from '@infrastructure/errors';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerCache } from './cache';

export const createCacheInvalidation = (cache: PlayerCache) => {
  const invalidateAll = (): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => cache.getPlayers(),
        (error) => error as APIError,
      ),
      TE.map(() => undefined),
    );

  const invalidatePlayer = (id: number): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => cache.getPlayer(id),
        (error) => error as APIError,
      ),
      TE.map(() => undefined),
    );

  const invalidatePlayerValues = (id: number): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => cache.getPlayerValues(id),
        (error) => error as APIError,
      ),
      TE.map(() => undefined),
    );

  const invalidatePlayerStats = (id: number): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => cache.getPlayerStats(id),
        (error) => error as APIError,
      ),
      TE.map(() => undefined),
    );

  return {
    invalidateAll,
    invalidatePlayer,
    invalidatePlayerValues,
    invalidatePlayerStats,
  } as const;
};

export type CacheInvalidation = ReturnType<typeof createCacheInvalidation>;
