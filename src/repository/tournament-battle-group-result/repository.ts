import { db } from 'db/index';
import { eq } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainTournamentBattleGroupResultToDbCreate,
  mapDbTournamentBattleGroupResultToDomain,
} from 'repository/tournament-battle-group-result/mapper';
import {
  TournamentBattleGroupResultCreateInputs,
  TournamentBattleGroupResultRepository,
} from 'repository/tournament-battle-group-result/types';
import * as schema from 'schema/tournament-battle-group-result';
import { TournamentBattleGroupResults } from 'types/domain/tournament-battle-group-result.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createTournamentBattleGroupResultRepository =
  (): TournamentBattleGroupResultRepository => {
    const findByTournamentId = (
      tournamentId: TournamentId,
    ): TE.TaskEither<DBError, TournamentBattleGroupResults> =>
      pipe(
        TE.tryCatch(
          async () => {
            const result = await db
              .select()
              .from(schema.tournamentBattleGroupResults)
              .where(eq(schema.tournamentBattleGroupResults.tournamentId, Number(tournamentId)));
            return result.map(mapDbTournamentBattleGroupResultToDomain);
          },
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to fetch tournament battle group result by tournament id ${tournamentId}: ${getErrorMessage(error)}`,
              cause: error instanceof Error ? error : undefined,
            }),
        ),
      );

    const saveBatchByTournamentId = (
      tournamentBattleGroupResultInputs: TournamentBattleGroupResultCreateInputs,
    ): TE.TaskEither<DBError, TournamentBattleGroupResults> =>
      pipe(
        TE.tryCatch(
          async () => {
            const dataToCreate = tournamentBattleGroupResultInputs.map(
              mapDomainTournamentBattleGroupResultToDbCreate,
            );
            await db
              .insert(schema.tournamentBattleGroupResults)
              .values(dataToCreate)
              .onConflictDoNothing({
                target: [
                  schema.tournamentBattleGroupResults.tournamentId,
                  schema.tournamentBattleGroupResults.groupId,
                ],
              });
          },
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to create tournament battle group results in batch: ${getErrorMessage(error)}`,
              cause: error instanceof Error ? error : undefined,
            }),
        ),
        TE.chain(() => findByTournamentId(tournamentBattleGroupResultInputs[0].tournamentId)),
      );

    return {
      findByTournamentId,
      saveBatchByTournamentId,
    };
  };
