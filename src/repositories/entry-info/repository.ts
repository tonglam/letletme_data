import { Prisma, PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
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

  const findByIds = (entryIds: ReadonlyArray<EntryId>): TE.TaskEither<DBError, EntryInfos> =>
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
      TE.map((prismaEntryInfos) => prismaEntryInfos.map(mapPrismaEntryInfoToDomain) as EntryInfos),
    );

  const findAllEntryIds = (): TE.TaskEither<DBError, ReadonlyArray<EntryId>> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryInfo.findMany({ select: { id: true } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all entry IDs: ${error}`,
          }),
      ),
      TE.map((prismaEntryInfos) =>
        prismaEntryInfos.map((entryInfo) => String(entryInfo.id) as unknown as EntryId),
      ),
    );

  const upsertEntryInfo = (entryInfo: EntryInfo): TE.TaskEither<DBError, EntryInfo> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryInfo.findUnique({ where: { id: Number(entryInfo.id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed fetch for entry ${entryInfo.id} during upsert prep: ${error}`,
          }),
      ),
      TE.chainW((existingPrismaEntryInfoOrNull) => {
        const entryId = Number(entryInfo.id);
        const { ...restOfEntryInfo } = entryInfo;

        return pipe(
          O.fromNullable(existingPrismaEntryInfoOrNull),
          O.match(
            () => {
              const createData: Prisma.EntryInfoCreateInput = {
                ...restOfEntryInfo,
                id: entryId,
                lastEntryName: '',
                lastOverallPoints: 0,
                lastOverallRank: 0,
                lastTeamValue: 0,
                usedEntryNames: [entryInfo.entryName],
              };
              return TE.tryCatch(
                () => prisma.entryInfo.create({ data: createData }),
                (error) =>
                  createDBError({
                    code: DBErrorCode.QUERY_ERROR,
                    message: `Failed create for entry ${entryId}: ${error}`,
                  }),
              );
            },
            (existingEntry) => {
              const currentUsedNames = existingEntry.usedEntryNames ?? [];
              const newName = entryInfo.entryName;
              const previousName = existingEntry.entryName;

              const updatedUsedEntryNames =
                newName !== previousName && !currentUsedNames.includes(newName)
                  ? [...currentUsedNames, newName]
                  : currentUsedNames;

              const updateData: Prisma.EntryInfoUpdateInput = {
                ...restOfEntryInfo,
                lastEntryName: previousName,
                lastOverallPoints: existingEntry.overallPoints,
                lastOverallRank: existingEntry.overallRank,
                lastTeamValue: existingEntry.teamValue,
                usedEntryNames: updatedUsedEntryNames,
              };
              return TE.tryCatch(
                () => prisma.entryInfo.update({ where: { id: entryId }, data: updateData }),
                (error) =>
                  createDBError({
                    code: DBErrorCode.QUERY_ERROR,
                    message: `Failed update for entry ${entryId}: ${error}`,
                  }),
              );
            },
          ),
        );
      }),
      TE.map(mapPrismaEntryInfoToDomain),
    );

  const deleteById = (id: EntryId): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.entryInfo.delete({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete entry info by id ${id}: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findById,
    findByIds,
    findAllEntryIds,
    upsertEntryInfo,
    deleteById,
  };
};
