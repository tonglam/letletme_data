import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainPlayerValueToPrismaCreate,
  mapPrismaPlayerValueToDomain,
} from 'src/repositories/player-value/mapper';
import { PlayerValueCreateInputs, PlayerValueRepository } from 'src/repositories/player-value/type';
import { RawPlayerValues } from 'src/types/domain/player-value.type';
import { PlayerId } from 'src/types/domain/player.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';
import { getErrorMessage } from 'src/utils/error.util';

export const createPlayerValueRepository = (prisma: PrismaClient): PlayerValueRepository => {
  const getLatestPlayerValuesByElements = (
    elementIds: ReadonlyArray<PlayerId>,
  ): TE.TaskEither<DBError, ReadonlyArray<{ elementId: PlayerId; value: number }>> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (elementIds.length === 0) {
            return [];
          }
          const latestValues = await prisma.playerValue.findMany({
            where: { elementId: { in: [...elementIds] } },
            orderBy: { changeDate: 'desc' },
            distinct: ['elementId'],
            select: { elementId: true, value: true },
          });
          return latestValues.map((v) => ({ ...v, elementId: v.elementId as PlayerId }));
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to get latest player values by elements: ${getErrorMessage(error)}`,
          }),
      ),
    );

  const findByChangeDate = (changeDate: string): TE.TaskEither<DBError, RawPlayerValues> =>
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

  const findByElement = (elementId: PlayerId): TE.TaskEither<DBError, RawPlayerValues> =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { elementId: { equals: elementId } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by element ${elementId}: ${error}`,
          }),
      ),
      TE.map((prismaPlayerValues) => prismaPlayerValues.map(mapPrismaPlayerValueToDomain)),
    );

  const findByElements = (
    elementIds: ReadonlyArray<PlayerId>,
  ): TE.TaskEither<DBError, RawPlayerValues> =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { elementId: { in: [...elementIds] } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by elements ${elementIds}: ${error}`,
          }),
      ),
      TE.map((prismaPlayerValues) => prismaPlayerValues.map(mapPrismaPlayerValueToDomain)),
    );

  const savePlayerValueChangesByChangeDate = (
    playerValueInputs: PlayerValueCreateInputs,
  ): TE.TaskEither<DBError, RawPlayerValues> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = playerValueInputs.map(mapDomainPlayerValueToPrismaCreate);
          await prisma.playerValue.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save player value changes: ${getErrorMessage(error)}`,
          }),
      ),
      TE.chain(() => findByChangeDate(playerValueInputs[0].changeDate)),
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

  return {
    getLatestPlayerValuesByElements,
    findByChangeDate,
    findByElement,
    findByElements,
    savePlayerValueChangesByChangeDate,
    deleteByChangeDate,
  };
};
