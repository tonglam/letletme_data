import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainTournamentKnockoutResultToDbCreate,
  mapDbTournamentKnockoutResultToDomain,
} from 'repositories/tournament-knockout-result/mapper';
import {
  TournamentKnockoutResultCreateInputs,
  TournamentKnockoutResultRepository,
} from 'repositories/tournament-knockout-result/types';
import * as schema from 'schema/tournament-knockout-result';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentKnockoutResults } from 'types/domain/tournament-knockout-result.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createTournamentKnockoutResultRepository = (): TournamentKnockoutResultRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentKnockoutResults> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.tournamentKnockoutResults)
            .where(eq(schema.tournamentKnockoutResults.tournamentId, Number(tournamentId)));
          return result.map(mapDbTournamentKnockoutResultToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament knockout result by tournament id ${tournamentId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentKnockoutResultInputs: TournamentKnockoutResultCreateInputs,
  ): TE.TaskEither<DBError, TournamentKnockoutResults> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = tournamentKnockoutResultInputs.map(
            mapDomainTournamentKnockoutResultToDbCreate,
          );
          await db
            .insert(schema.tournamentKnockoutResults)
            .values(dataToCreate)
            .onConflictDoNothing({
              target: [schema.tournamentKnockoutResults.tournamentId],
            });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament knockout results in batch: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
      TE.chain(() => findByTournamentId(tournamentKnockoutResultInputs[0].tournamentId)),
    );

  return {
    findByTournamentId,
    saveBatchByTournamentId,
  };
};
