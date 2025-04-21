import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainPlayerValueToPrismaCreate,
  mapPrismaPlayerValueToDomain,
} from 'src/repositories/player-value/mapper';
import { PlayerValueCreateInputs, PlayerValueRepository } from 'src/repositories/player-value/type';
import { SourcePlayerValues } from 'src/types/domain/player-value.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerValueRepository = (prisma: PrismaClient): PlayerValueRepository => {
  const findByChangeDate = (changeDate: string): TE.TaskEither<DBError, SourcePlayerValues> =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { changeDate: { equals: changeDate } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by change date ${changeDate}: ${error}`,
          }),
      ),
      TE.map((prismaPlayerValues) => prismaPlayerValues.map(mapPrismaPlayerValueToDomain)),
    );

  const findByElement = (element: number): TE.TaskEither<DBError, SourcePlayerValues> =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { element: { equals: element } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by element ${element}: ${error}`,
          }),
      ),
      TE.map((prismaPlayerValues) => prismaPlayerValues.map(mapPrismaPlayerValueToDomain)),
    );

  const findByElements = (elements: number[]): TE.TaskEither<DBError, SourcePlayerValues> =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { element: { in: elements } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by elements ${elements}: ${error}`,
          }),
      ),
      TE.map((prismaPlayerValues) => prismaPlayerValues.map(mapPrismaPlayerValueToDomain)),
    );

  const saveBatch = (
    playerValues: PlayerValueCreateInputs,
  ): TE.TaskEither<DBError, SourcePlayerValues> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerValues.map(mapDomainPlayerValueToPrismaCreate);
          await prisma.playerValue.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save player values: ${getErrorMessage(error)}`,
          }),
      ),
      TE.chain(() => findByChangeDate(playerValues[0].changeDate)),
    );

  const deleteByChangeDate = (changeDate: string): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.deleteMany({ where: { changeDate: { equals: changeDate } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete player values by change date ${changeDate}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.map(() => void 0),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
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
      TE.map(() => void 0),
    );

  return {
    findByChangeDate,
    findByElement,
    findByElements,
    saveBatch,
    deleteByChangeDate,
    deleteAll,
  };
};
