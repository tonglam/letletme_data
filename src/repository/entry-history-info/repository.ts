import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEntryHistoryInfoToDbCreate,
  mapDbEntryHistoryInfoToDomain,
} from 'repository/entry-history-info/mapper';
import {
  EntryHistoryInfoCreateInputs,
  EntryHistoryInfoRepository,
} from 'repository/entry-history-info/types';
import * as schema from 'schema/entry-history-info';
import { EntryHistoryInfos } from 'types/domain/entry-history-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEntryHistoryInfoRepository = (): EntryHistoryInfoRepository => {
  const findByEntryId = (entryId: EntryId): TE.TaskEither<DBError, EntryHistoryInfos> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryHistoryInfos)
            .where(eq(schema.entryHistoryInfos.entryId, Number(entryId)));
          return result.map(mapDbEntryHistoryInfoToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry history info by id ${entryId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByEntryId = (
    entryHistoryInfoInputs: EntryHistoryInfoCreateInputs,
  ): TE.TaskEither<DBError, EntryHistoryInfos> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db
            .insert(schema.entryHistoryInfos)
            .values(entryHistoryInfoInputs.map(mapDomainEntryHistoryInfoToDbCreate))
            .onConflictDoNothing();
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to save entry history info: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() => findByEntryId(entryHistoryInfoInputs[0].entryId)),
    );

  return {
    findByEntryId,
    saveBatchByEntryId,
  };
};
