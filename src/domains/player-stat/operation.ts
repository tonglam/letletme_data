import {
  PlayerStatCache,
  PlayerStatOperations,
  PlayerStatRepository,
} from 'domains/player-stat/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PrismaPlayerStatCreateInput } from 'src/repositories/player-stat/type';
import { EventId } from 'src/types/domain/event.type';
import { PlayerStatId } from 'src/types/domain/player-stat.type';
import { createDomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerStatOperations = (
  repository: PlayerStatRepository,
  cache: PlayerStatCache,
): PlayerStatOperations => ({
  getAllPlayerStats: () =>
    pipe(
      cache.getAllPlayerStats(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Cache Error (getAllPlayerStats): ${getErrorMessage(error)}`,
        }),
      ),
      TE.chain((cachedPlayerStats) =>
        cachedPlayerStats && cachedPlayerStats.length > 0
          ? TE.right(cachedPlayerStats)
          : pipe(
              repository.findAll(),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findAll): ${getErrorMessage(dbError)}`,
                }),
              ),
              TE.chainFirst((playerStats) =>
                playerStats && playerStats.length > 0
                  ? pipe(
                      cache.setAllPlayerStats(playerStats),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Cache Error (setAllPlayerStats): ${getErrorMessage(error)}`,
                        }),
                      ),
                    )
                  : TE.right(undefined),
              ),
            ),
      ),
    ),

  getPlayerStatById: (id: PlayerStatId) =>
    pipe(
      cache.getPlayerStat(id),
      TE.chain((cachedPlayerStat) =>
        cachedPlayerStat
          ? TE.right(cachedPlayerStat)
          : pipe(
              repository.findById(id),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findById ${id}): ${getErrorMessage(dbError)}`,
                  cause: dbError,
                }),
              ),
            ),
      ),
    ),

  savePlayerStats: (playerStats: readonly PrismaPlayerStatCreateInput[]) =>
    pipe(
      repository.saveBatch(playerStats),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
        }),
      ),
      TE.chainFirst((createdPlayerStats) =>
        pipe(
          cache.setAllPlayerStats(createdPlayerStats),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Cache Error (setAllPlayerStats): ${getErrorMessage(error)}`,
              cause: error,
            }),
          ),
        ),
      ),
    ),

  deleteAllPlayerStats: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
        }),
      ),
      TE.chainFirst(() => pipe(cache.deleteAllPlayerStats())),
    ),

  deletePlayerStatsByEventId: (eventId: EventId) =>
    pipe(
      repository.deleteByEventId(eventId),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deletePlayerStatsByEventId ${eventId}): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
      TE.chainFirst(() => pipe(cache.deletePlayerStatsByEventId(eventId))),
    ),
});
