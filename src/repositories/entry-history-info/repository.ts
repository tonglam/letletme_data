import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEntryHistoryInfoToPrismaCreate,
  mapPrismaEntryHistoryInfoToDomain,
} from 'src/repositories/entry-history-info/mapper';
import {
  EntryHistoryInfoCreateInputs,
  EntryHistoryInfoRepository,
} from 'src/repositories/entry-history-info/types';
import { EntryHistoryInfos } from 'src/types/domain/entry-history-info.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createEntryHistoryInfoRepository = (
  prisma: PrismaClient,
): EntryHistoryInfoRepository => {
  const findByEntryId = (entryId: EntryId): TE.TaskEither<DBError, EntryHistoryInfos> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryHistoryInfo.findMany({ where: { entryId: Number(entryId) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry league info by id ${entryId}: ${error}`,
          }),
      ),
      TE.chainW((prismaEntryLeagueInfoOrNull) =>
        prismaEntryLeagueInfoOrNull
          ? TE.right(prismaEntryLeagueInfoOrNull.map(mapPrismaEntryHistoryInfoToDomain))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Entry league info with ID ${entryId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByEntryId = (
    entryHistoryInfoInputs: EntryHistoryInfoCreateInputs,
  ): TE.TaskEither<DBError, EntryHistoryInfos> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryHistoryInfo.createMany({
            data: entryHistoryInfoInputs.map(mapDomainEntryHistoryInfoToPrismaCreate),
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save entry history info: ${error}`,
          }),
      ),
      TE.chain(() => findByEntryId(entryHistoryInfoInputs[0].entryId)),
    );

  const deleteByEntryId = (entryId: EntryId): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryHistoryInfo.deleteMany({ where: { entryId: Number(entryId) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete entry history info by id ${entryId}: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findByEntryId,
    saveBatchByEntryId,
    deleteByEntryId,
  };
};
