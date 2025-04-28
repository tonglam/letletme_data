import { db } from 'db/index';
import { eq, and } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDbEntryLeagueInfoToDomain } from 'repositories/entry-league-info/mapper';
import {
  DbEntryLeagueInfoCreateInput,
  EntryLeagueInfoRepository,
} from 'repositories/entry-league-info/types';
import * as schema from 'schema/entry-league-info';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfo, EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { LeagueId } from 'types/domain/league.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEntryLeagueInfoRepository = (): EntryLeagueInfoRepository => {
  const findByEntryId = (entryId: EntryId): TE.TaskEither<DBError, EntryLeagueInfos> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryLeagueInfos)
            .where(eq(schema.entryLeagueInfos.entryId, Number(entryId)));
          return result.map(mapDbEntryLeagueInfoToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry league info by entry id ${entryId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByEntryIdAndLeagueId = (
    entryId: EntryId,
    leagueId: LeagueId,
  ): TE.TaskEither<DBError, EntryLeagueInfo> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryLeagueInfos)
            .where(
              and(
                eq(schema.entryLeagueInfos.entryId, Number(entryId)),
                eq(schema.entryLeagueInfos.leagueId, Number(leagueId)),
              ),
            )
            .limit(1);
          return mapDbEntryLeagueInfoToDomain(result[0]);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry league info by entry ${entryId}, league ${leagueId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const upsertEntryLeagueInfo = (
    entryLeagueInfoInput: DbEntryLeagueInfoCreateInput,
  ): TE.TaskEither<DBError, EntryLeagueInfo> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db
            .insert(schema.entryLeagueInfos)
            .values(entryLeagueInfoInput)
            .onConflictDoUpdate({
              target: [schema.entryLeagueInfos.entryId, schema.entryLeagueInfos.leagueId],
              set: entryLeagueInfoInput,
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to upsert entry league info for entry ${entryLeagueInfoInput.entryId}, league ${entryLeagueInfoInput.leagueId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chainW(() =>
        findByEntryIdAndLeagueId(
          entryLeagueInfoInput.entryId as EntryId,
          entryLeagueInfoInput.leagueId as LeagueId,
        ),
      ),
    );

  return {
    findByEntryId,
    findByEntryIdAndLeagueId,
    upsertEntryLeagueInfo,
  };
};
