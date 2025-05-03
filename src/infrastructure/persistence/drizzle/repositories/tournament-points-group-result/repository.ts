import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDbTournamentPointsGroupResultToDomain,
  mapDomainTournamentPointsGroupResultToDbCreate,
} from 'repository/tournament-points-group-result/mapper';
import {
  TournamentPointsGroupResultCreateInputs,
  TournamentPointsGroupResultRepository,
} from 'repository/tournament-points-group-result/types';
import * as schema from 'schema/tournament-points-group-result.schema';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentPointsGroupResults } from 'types/domain/tournament-points-group-result.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createTournamentPointsGroupResultRepository =
  (): TournamentPointsGroupResultRepository => {
    const findByTournamentId = (
      tournamentId: TournamentId,
    ): TE.TaskEither<DBError, TournamentPointsGroupResults> =>
      pipe(
        TE.tryCatch(
          async () => {
            const result = await db
              .select()
              .from(schema.tournamentPointsGroupResults)
              .where(eq(schema.tournamentPointsGroupResults.tournamentId, Number(tournamentId)));
            return result.map(mapDbTournamentPointsGroupResultToDomain);
          },
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to fetch tournament points group result by tournament id ${tournamentId}: ${getErrorMessage(error)}`,
              cause: error instanceof Error ? error : undefined,
            }),
        ),
      );

    const saveBatchByTournamentId = (
      tournamentPointsGroupResultInputs: TournamentPointsGroupResultCreateInputs,
    ): TE.TaskEither<DBError, TournamentPointsGroupResults> =>
      pipe(
        TE.tryCatch(
          async () => {
            const dataToCreate = tournamentPointsGroupResultInputs.map(
              mapDomainTournamentPointsGroupResultToDbCreate,
            );
            await db
              .insert(schema.tournamentPointsGroupResults)
              .values(dataToCreate)
              .onConflictDoNothing({
                target: [
                  schema.tournamentPointsGroupResults.tournamentId,
                  schema.tournamentPointsGroupResults.groupId,
                ],
              });
          },
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to create tournament points group results in batch: ${getErrorMessage(error)}`,
              cause: error instanceof Error ? error : undefined,
            }),
        ),
        TE.chain(() => findByTournamentId(tournamentPointsGroupResultInputs[0].tournamentId)),
      );

    return {
      findByTournamentId,
      saveBatchByTournamentId,
    };
  };
