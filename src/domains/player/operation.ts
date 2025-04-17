import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { PrismaPlayerCreate } from 'src/repositories/player/type';
import { PlayerId } from 'src/types/domain/player.type';
import { createDomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

import { PlayerCache, PlayerOperations, PlayerRepository } from './types';

export const createPlayerOperations = (
  repository: PlayerRepository,
  cache: PlayerCache,
): PlayerOperations => ({
  getAllPlayers: () =>
    pipe(
      cache.getAllPlayers(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Cache Error (getAllPlayers): ${getErrorMessage(error)}`,
        }),
      ),
      TE.chain((cachedPlayers) =>
        cachedPlayers && cachedPlayers.length > 0
          ? TE.right(cachedPlayers)
          : pipe(
              repository.findAll(),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findAll): ${getErrorMessage(dbError)}`,
                }),
              ),
              TE.chainFirst((players) =>
                players && players.length > 0
                  ? pipe(
                      cache.setAllPlayers(players),
                      TE.mapLeft((cacheError) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Cache Error (setAllPlayers): ${getErrorMessage(cacheError)}`,
                        }),
                      ),
                    )
                  : TE.right(undefined),
              ),
            ),
      ),
    ),

  getPlayerById: (id: PlayerId) =>
    pipe(
      cache.getPlayer(id),
      TE.chain((cachedPlayer) =>
        cachedPlayer
          ? TE.right(cachedPlayer)
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

  savePlayers: (players: readonly PrismaPlayerCreate[]) =>
    pipe(
      repository.saveBatch(players),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
        }),
      ),
      TE.chainFirst((createdPlayers) =>
        pipe(
          cache.setAllPlayers(createdPlayers),
          TE.mapLeft((cacheError) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Cache Error (setAllPlayers): ${getErrorMessage(cacheError)}`,
              cause: cacheError instanceof Error ? cacheError : undefined,
            }),
          ),
        ),
      ),
    ),

  deleteAllPlayers: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
        }),
      ),
      TE.chainFirst(() => pipe(cache.deleteAllPlayers())),
    ),
});
