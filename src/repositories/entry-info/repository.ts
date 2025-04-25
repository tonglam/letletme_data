import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapPrismaEntryInfoToDomain } from 'src/repositories/entry-info/mapper';
import { EntryInfoRepository } from 'src/repositories/entry-info/types';
import { EntryId, EntryInfo, EntryInfos } from 'src/types/domain/entry-info.type';
import { createDBError, DBError, DBErrorCode } from 'src/types/error.type';

export const createEntryInfoRepository = (prisma: PrismaClient): EntryInfoRepository => {
  const findById = (id: EntryId): TE.TaskEither<DBError, EntryInfo> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryInfo.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry info by id ${id}: ${error}`,
          }),
      ),
      TE.chainW((prismaEntryInfoOrNull) =>
        prismaEntryInfoOrNull
          ? TE.right(mapPrismaEntryInfoToDomain(prismaEntryInfoOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Entry info with ID ${id} not found in database`,
              }),
            ),
      ),
    );

  const findByEntryIds = (entryIds: ReadonlyArray<EntryId>): TE.TaskEither<DBError, EntryInfos> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryInfo.findMany({ where: { id: { in: entryIds.map((id) => Number(id)) } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry info by ids ${entryIds}: ${error}`,
          }),
      ),
      TE.map((prismaEntryInfos) => prismaEntryInfos.map(mapPrismaEntryInfoToDomain)),
    );

  const upsertEntryInfo = (entryInfo: EntryInfo): TE.TaskEither<DBError, EntryInfo> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.entryInfo.upsert({
            where: { id: Number(entryInfo.id) },
            update: entryInfo,
            create: entryInfo,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to upsert entry info: ${error}`,
          }),
      ),
      TE.map(mapPrismaEntryInfoToDomain),
    );

  const deleteEntryInfo = (id: EntryId): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryInfo.delete({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete entry info: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findById,
    findByEntryIds,
    upsertEntryInfo,
    deleteEntryInfo,
  };
};
