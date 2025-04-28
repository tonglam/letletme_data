import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainTournamentKnockoutToDbCreate,
  mapDbTournamentKnockoutToDomain,
} from 'repository/tournament-knockout/mapper';
import {
  TournamentKnockoutCreateInputs,
  TournamentKnockoutRepository,
} from 'repository/tournament-knockout/types';
import * as schema from 'schema/tournament-knockout';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentKnockouts } from 'types/domain/tournament-knockout.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createTournamentKnockoutRepository = (): TournamentKnockoutRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentKnockouts> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.tournamentKnockouts)
            .where(eq(schema.tournamentKnockouts.tournamentId, Number(tournamentId)));
          return result.map(mapDbTournamentKnockoutToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament knockout by tournament id ${tournamentId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentKnockoutInputs: TournamentKnockoutCreateInputs,
  ): TE.TaskEither<DBError, TournamentKnockouts> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = tournamentKnockoutInputs.map(mapDomainTournamentKnockoutToDbCreate);
          await db
            .insert(schema.tournamentKnockouts)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.tournamentKnockouts.tournamentId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament knockouts in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() => findByTournamentId(tournamentKnockoutInputs[0].tournamentId)),
    );

  return {
    findByTournamentId,
    saveBatchByTournamentId,
  };
};
