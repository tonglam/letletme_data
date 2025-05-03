import { db } from 'db/index';
import { eq, and, sql } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDbEntryLeagueInfoToDomain,
  mapDomainEntryLeagueInfoToDbCreate,
} from 'repository/entry-league-info/mapper';
import {
  EntryLeagueInfoCreateInputs,
  EntryLeagueInfoRepository,
} from 'repository/entry-league-info/types';
import * as schema from 'schema/entry-league-info.schema';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryLeagueInfo, EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { LeagueId } from 'types/domain/league.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

const getUniqueEntryIds = (inputs: EntryLeagueInfoCreateInputs): ReadonlyArray<EntryId> => {
  const ids = inputs.map((input) => input.entryId);
  const primitiveIds = ids.map(Number);
  return [...new Set(primitiveIds)].map((id) => id as EntryId);
};

export const createEntryLeagueInfoRepository = (): EntryLeagueInfoRepository => {
  const findByEntryId = (entryId: EntryId): TE.TaskEither<DBError, EntryLeagueInfos> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.entryLeagueInfos)
            .where(eq(schema.entryLeagueInfos.entryId, Number(entryId)));
          if (!result || result.length === 0) {
            return [];
          }
          return result.map(mapDbEntryLeagueInfoToDomain);
        },
        (error: unknown): DBError =>
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
          if (!result || result.length === 0) {
            throw new Error('Entry league info not found');
          }
          return mapDbEntryLeagueInfoToDomain(result[0]);
        },
        (error: unknown): DBError =>
          createDBError({
            code:
              error instanceof Error && error.message.includes('not found')
                ? DBErrorCode.NOT_FOUND
                : DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch entry league info by entry ${entryId}, league ${leagueId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const upsertLeagueInfoBatch = (
    entryLeagueInfoInputs: EntryLeagueInfoCreateInputs,
  ): TE.TaskEither<DBError, EntryLeagueInfos> => {
    const uniqueEntryIds = getUniqueEntryIds(entryLeagueInfoInputs);

    return pipe(
      TE.tryCatch(
        async () => {
          if (entryLeagueInfoInputs.length === 0) {
            return;
          }
          const dataToCreate = entryLeagueInfoInputs.map(mapDomainEntryLeagueInfoToDbCreate);
          await db
            .insert(schema.entryLeagueInfos)
            .values(dataToCreate)
            .onConflictDoUpdate({
              target: [schema.entryLeagueInfos.entryId, schema.entryLeagueInfos.leagueId],
              set: {
                leagueName: sql`excluded.league_name`,
                leagueType: sql`excluded.league_type`,
                startedEvent: sql`excluded.started_event`,
                entryRank: sql`excluded.entry_rank`,
                entryLastRank: sql`excluded.entry_last_rank`,
              },
            });
        },
        (error: unknown): DBError =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to batch upsert entry league info: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chainW(() => {
        if (uniqueEntryIds.length === 0) {
          return TE.right([]);
        }
        return pipe(
          uniqueEntryIds,
          TE.traverseArray(findByEntryId),
          TE.map((arrayOfLeagueInfos) => arrayOfLeagueInfos.flat()),
        );
      }),
    );
  };

  return {
    findByEntryId,
    findByEntryIdAndLeagueId,
    upsertLeagueInfoBatch,
  };
};
