import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  TournamentBattleGroupResultCreateInputs,
  TournamentBattleGroupResultRepository,
} from 'src/repositories/tournament-battle-group-result/types';
import { TournamentBattleGroupResults } from 'src/types/domain/tournament-battle-group-result.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

import {
  mapDomainTournamentBattleGroupResultToPrismaCreate,
  mapPrismaTournamentBattleGroupResultToDomain,
} from './mapper';
import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createTournamentBattleGroupResultRepository = (
  prismaClient: PrismaClient,
): TournamentBattleGroupResultRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentBattleGroupResults> =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.tournamentBattleGroupResult.findMany({
            where: { tournamentId: Number(tournamentId) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament battle group result by tournament id ${tournamentId}: ${error}`,
          }),
      ),
      TE.chainW((prismaTournamentBattleGroupResultOrNull) =>
        prismaTournamentBattleGroupResultOrNull
          ? TE.right(
              prismaTournamentBattleGroupResultOrNull.map(
                mapPrismaTournamentBattleGroupResultToDomain,
              ),
            )
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Tournament battle group result with tournament id ${tournamentId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentBattleGroupResultInputs: TournamentBattleGroupResultCreateInputs,
  ): TE.TaskEither<DBError, TournamentBattleGroupResults> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = tournamentBattleGroupResultInputs.map(
            mapDomainTournamentBattleGroupResultToPrismaCreate,
          );
          await prismaClient.tournamentBattleGroupResult.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament battle group results in batch: ${error}`,
          }),
      ),
      TE.chain(() => findByTournamentId(tournamentBattleGroupResultInputs[0].tournamentId)),
    );

  return {
    findByTournamentId,
    saveBatchByTournamentId,
  };
};
