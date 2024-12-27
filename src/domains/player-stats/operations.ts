import { APIError, createInternalServerError } from '@infrastructure/errors';
import { PlayerStat, PlayerStatsResponse } from '@types/playerStats.type';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PlayerStatsCache } from './cache/cache';
import { PlayerStatsInvalidation } from './cache/invalidation';
import { PlayerStatsRepository } from './repository';

export const createPlayerStatsOperations = (
  repository: PlayerStatsRepository,
  cache: PlayerStatsCache,
  cacheInvalidation: PlayerStatsInvalidation,
) => {
  // Core processing functions
  const processStats = (
    response: PlayerStatsResponse,
    eventId: number,
  ): TE.TaskEither<APIError, void> =>
    pipe(
      repository.processStatsResponse(response, eventId),
      TE.chain(() => cacheInvalidation.invalidatePlayerStats(eventId, eventId)),
      TE.mapLeft((error) => createInternalServerError({ message: error.message })),
    );

  // Query operations
  const getPlayerStats = (
    playerId: number,
    eventId: number,
  ): TE.TaskEither<APIError, ReadonlyArray<PlayerStat>> =>
    pipe(
      cache.getPlayerStats(playerId, eventId),
      TE.orElse(() =>
        pipe(
          repository.findByPlayerId(playerId, eventId),
          TE.chain((stats) =>
            pipe(
              cache.setPlayerStats(playerId, eventId, stats),
              TE.map(() => stats),
            ),
          ),
        ),
      ),
    );

  const getLatestPlayerStats = (playerId: number): TE.TaskEither<APIError, PlayerStat | null> =>
    pipe(
      cache.getLatestPlayerStats(playerId),
      TE.orElse(() =>
        pipe(
          repository.findLatestByPlayerId(playerId),
          TE.chain((stats) =>
            stats
              ? pipe(
                  cache.setLatestPlayerStats(playerId, stats),
                  TE.map(() => stats),
                )
              : TE.right(null),
          ),
        ),
      ),
    );

  return {
    processStats,
    getPlayerStats,
    getLatestPlayerStats,
  } as const;
};

export type PlayerStatsOperations = ReturnType<typeof createPlayerStatsOperations>;
