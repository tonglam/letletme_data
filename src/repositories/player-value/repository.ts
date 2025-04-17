import { Prisma, PrismaClient, PlayerValue as PrismaPlayerValueType } from '@prisma/client';
import { PlayerValueRepository } from 'domains/player-value/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainPlayerValueToPrismaCreate,
  mapPrismaPlayerValueToDomain,
} from 'src/repositories/player-value/mapper';
import { PrismaPlayerValueCreate } from 'src/repositories/player-value/type';
import { PlayerValueId } from 'src/types/domain/player-value.type';
import { createDBError, DBErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerValueRepository = (prisma: PrismaClient): PlayerValueRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ orderBy: { id: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all player values: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map((playerValues: PrismaPlayerValueType[]) =>
        playerValues.map(mapPrismaPlayerValueToDomain),
      ),
    ),

  findById: (id: PlayerValueId) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findUnique({ where: { id: parseInt(id, 10) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player value by id ${id}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map((playerValue) => (playerValue ? mapPrismaPlayerValueToDomain(playerValue) : null)),
    ),

  saveBatch: (playerValues: readonly PrismaPlayerValueCreate[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerValues.map(mapDomainPlayerValueToPrismaCreate);
          await prisma.playerValue.createMany({
            data: dataToCreate as unknown as Prisma.PlayerValueCreateManyInput[],
            skipDuplicates: true,
          });

          const uniqueIdentifiers = dataToCreate.map((p) => ({
            elementId: p.elementId,
            changeDate: p.changeDate,
          }));

          return prisma.playerValue.findMany({
            where: {
              OR: uniqueIdentifiers,
            },
            orderBy: { id: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save player values: ${getErrorMessage(error)}`,
          }),
      ),
      TE.map((prismaPlayerValues) => prismaPlayerValues.map(mapPrismaPlayerValueToDomain)),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.deleteMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all player values: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => undefined as void),
    ),
});
