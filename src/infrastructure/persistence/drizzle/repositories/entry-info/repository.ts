import { db } from 'db/index';
import { eq, inArray } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { mapDbEntryInfoToDomain } from 'repository/entry-info/mapper';
import {
  DbEntryInfo,
  DbEntryInfoCreateInput,
  DbEntryInfoUpdateInput,
  EntryInfoRepository,
} from 'repository/entry-info/types';
import * as schema from 'schema/entry-info.schema';
import { EntryId, EntryInfo, EntryInfos } from 'types/domain/entry-info.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEntryInfoRepository = (): EntryInfoRepository => {
  const findById = (id: EntryId): TE.TaskEither<DBError, EntryInfo> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryInfos)
            .where(eq(schema.entryInfos.id, Number(id)))
            .limit(1);
          return mapDbEntryInfoToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry info by id ${id}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByIds = (ids: ReadonlyArray<EntryId>): TE.TaskEither<DBError, EntryInfos> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryInfos)
            .where(
              inArray(
                schema.entryInfos.id,
                ids.map((id) => Number(id)),
              ),
            );
          return result.map(mapDbEntryInfoToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry info by ids ${ids.join(', ')}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findAllIds = (): TE.TaskEither<DBError, ReadonlyArray<EntryId>> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db.select({ id: schema.entryInfos.id }).from(schema.entryInfos);
          return result.map((entryInfo) => entryInfo.id as EntryId);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all entry IDs: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const upsertEntryInfo = (entryInfo: EntryInfo): TE.TaskEither<DBError, EntryInfo> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryInfos)
            .where(eq(schema.entryInfos.id, Number(entryInfo.id)))
            .limit(1);
          return result.length > 0 ? result[0] : null;
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed fetch for entry ${entryInfo.id} during upsert prep: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chainW((existingDbEntryInfoOrNull: DbEntryInfo | null) => {
        const entryId = Number(entryInfo.id);
        const { ...restOfEntryInfo } = entryInfo;

        return pipe(
          O.fromNullable(existingDbEntryInfoOrNull),
          O.match(
            () => {
              const createData: DbEntryInfoCreateInput = {
                ...restOfEntryInfo,
                id: entryId,
                lastEntryName: null,
                lastOverallPoints: null,
                lastOverallRank: null,
                lastTeamValue: null,
                usedEntryNames: [entryInfo.entryName],
                createdAt: new Date(),
              };
              return TE.tryCatch(
                async () => {
                  await db.insert(schema.entryInfos).values(createData);
                },
                (error) =>
                  createDBError({
                    code: DBErrorCode.QUERY_ERROR,
                    message: `Failed create for entry ${entryId}: ${getErrorMessage(error)}`,
                    cause: error instanceof Error ? error : undefined,
                  }),
              );
            },
            (existingEntry: DbEntryInfo) => {
              const currentUsedNames = existingEntry.usedEntryNames ?? [];
              const newName = entryInfo.entryName;
              const previousName = existingEntry.entryName;

              const updatedUsedEntryNames =
                newName !== previousName && !currentUsedNames.includes(newName)
                  ? [...currentUsedNames, newName]
                  : currentUsedNames;

              const updateData: DbEntryInfoUpdateInput = {
                ...restOfEntryInfo,
                lastEntryName: previousName,
                lastOverallPoints: existingEntry.overallPoints ?? undefined,
                lastOverallRank: existingEntry.overallRank ?? undefined,
                lastTeamValue: existingEntry.teamValue ?? undefined,
                usedEntryNames: updatedUsedEntryNames,
              };
              return TE.tryCatch(
                async () => {
                  await db
                    .update(schema.entryInfos)
                    .set(updateData)
                    .where(eq(schema.entryInfos.id, entryId));
                },
                (error) =>
                  createDBError({
                    code: DBErrorCode.QUERY_ERROR,
                    message: `Failed update for entry ${entryId}: ${getErrorMessage(error)}`,
                    cause: error instanceof Error ? error : undefined,
                  }),
              );
            },
          ),
        );
      }),
      TE.chainW(() => findById(entryInfo.id)),
    );

  return {
    findById,
    findByIds,
    findAllIds,
    upsertEntryInfo,
  };
};
