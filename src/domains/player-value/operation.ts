import {
  PlayerValueCache,
  PlayerValueOperations,
  PlayerValueRepository,
} from 'domains/player-value/types';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { PrismaPlayerValueCreate } from 'src/repositories/player-value/type';
import { PlayerValueId } from 'src/types/domain/player-value.type';
import { createDomainError, DomainErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerValueOperations = (
  repository: PlayerValueRepository,
  cache: PlayerValueCache,
): PlayerValueOperations => ({
  getAllPlayerValues: () =>
    pipe(
      cache.getAllPlayerValues(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Cache Error (getAllPlayerValues): ${getErrorMessage(error)}`,
        }),
      ),
      TE.chain((cachedPlayerValues) =>
        cachedPlayerValues && cachedPlayerValues.length > 0
          ? TE.right(cachedPlayerValues)
          : pipe(
              repository.findAll(),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findAll): ${getErrorMessage(dbError)}`,
                }),
              ),
              TE.chainFirst((playerValues) =>
                playerValues && playerValues.length > 0
                  ? pipe(
                      cache.setAllPlayerValues(playerValues),
                      TE.mapLeft((error) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Cache Error (setAllPlayerValues): ${getErrorMessage(error)}`,
                        }),
                      ),
                    )
                  : TE.right(undefined),
              ),
            ),
      ),
    ),

  getPlayerValueById: (id: PlayerValueId) =>
    pipe(
      cache.getPlayerValue(id),
      TE.chain((cachedPlayerValue) =>
        cachedPlayerValue
          ? TE.right(cachedPlayerValue)
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

  savePlayerValues: (playerValues: readonly PrismaPlayerValueCreate[]) =>
    pipe(
      repository.saveBatch(playerValues),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
        }),
      ),
      TE.chainFirst((createdPlayerValues) =>
        pipe(
          cache.setAllPlayerValues(createdPlayerValues),
          TE.mapLeft((error) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Cache Error (setAllPlayerValues): ${getErrorMessage(error)}`,
            }),
          ),
        ),
      ),
    ),

  deleteAllPlayerValues: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
        }),
      ),
      TE.chainFirst(() => pipe(cache.deleteAllPlayerValues())),
    ),
});
