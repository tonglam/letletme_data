import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainTournamentEntryToDbCreate,
  mapDbTournamentEntryToDomain,
} from 'repositories/tournament-entry/mapper';
import {
  TournamentEntryCreateInputs,
  TournamentEntryRepository,
} from 'repositories/tournament-entry/types';
import * as schema from 'schema/tournament-entry';
import { EntryId } from 'types/domain/entry-info.type';
import { TournamentEntries } from 'types/domain/tournament-entry.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createTournamentEntryRepository = (): TournamentEntryRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentEntries> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.tournamentEntries)
            .where(eq(schema.tournamentEntries.tournamentId, Number(tournamentId)));
          return result.map(mapDbTournamentEntryToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament entry by tournament id ${tournamentId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findAllTournamentEntryIds = (): TE.TaskEither<DBError, ReadonlyArray<EntryId>> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select({ entryId: schema.tournamentEntries.entryId })
            .from(schema.tournamentEntries);
          const uniqueEntryIds = Array.from(
            new Set(result.map((tournamentEntry) => tournamentEntry.entryId as EntryId)),
          );
          return uniqueEntryIds;
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all tournament entry ids: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentEntryInputs: TournamentEntryCreateInputs,
  ): TE.TaskEither<DBError, TournamentEntries> =>
    pipe(
      TE.tryCatch(
        async () => {
          if (tournamentEntryInputs.length === 0) {
            return;
          }
          await db
            .insert(schema.tournamentEntries)
            .values(tournamentEntryInputs.map(mapDomainTournamentEntryToDbCreate))
            .onConflictDoNothing({
              target: [schema.tournamentEntries.tournamentId, schema.tournamentEntries.entryId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament entries in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() =>
        tournamentEntryInputs.length > 0
          ? findByTournamentId(tournamentEntryInputs[0].tournamentId)
          : TE.right([] as TournamentEntries),
      ),
    );

  return {
    findByTournamentId,
    findAllTournamentEntryIds,
    saveBatchByTournamentId,
  };
};
