import { PrismaClient } from '@prisma/client';
import { PlayerValueRepository } from 'domains/player-value/types';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import {
  mapDomainPlayerValueToPrismaCreate,
  mapPrismaPlayerValueToDomain,
} from 'src/repositories/player-value/mapper';
import { PrismaPlayerValueCreate } from 'src/repositories/player-value/type';
import { PlayerValueId } from 'src/types/domain/player-value.type';
import { createDBError, DBErrorCode } from 'src/types/error.type';

export const createPlayerValueRepository = (prisma: PrismaClient): PlayerValueRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ orderBy: { id: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all player values: ${error}`,
          }),
      ),
      TE.map((playerValues) => playerValues.map(mapPrismaPlayerValueToDomain)),
    ),

  findById: (id: PlayerValueId) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findUnique({ where: { id } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player value by id ${id}: ${error}`,
          }),
      ),
      TE.map((playerValue) => (playerValue ? mapPrismaPlayerValueToDomain(playerValue) : null)),
    ),

  saveBatch: (playerValues: readonly PrismaPlayerValueCreate[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerValues.map(mapDomainPlayerValueToPrismaCreate);
          await prisma.playerValue.createMany({ data: dataToCreate });

          const ids = playerValues.map((p) => p.id as string);

          return prisma.playerValue.findMany({
            where: { id: { in: ids } },
            orderBy: { id: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save player values: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map((playerValues) => playerValues.map(mapPrismaPlayerValueToDomain)),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.deleteMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all player values: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    ),
});
