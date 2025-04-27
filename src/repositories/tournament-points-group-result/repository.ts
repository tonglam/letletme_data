import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  TournamentPointsGroupResultCreateInputs,
  TournamentPointsGroupResultRepository,
} from 'src/repositories/tournament-points-group-result/types';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { TournamentPointsGroupResults } from 'src/types/domain/tournament-points-group-result.type';

import {
  mapDomainTournamentPointsGroupResultToPrismaCreate,
  mapPrismaTournamentPointsGroupResultToDomain,
} from './mapper';
import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createTournamentPointsGroupResultRepository = (
  prismaClient: PrismaClient,
): TournamentPointsGroupResultRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentPointsGroupResults> =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.tournamentPointsGroupResult.findMany({
            where: { tournamentId: Number(tournamentId) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament points group result by tournament id ${tournamentId}: ${error}`,
          }),
      ),
      TE.chainW((prismaTournamentPointsGroupResultOrNull) =>
        prismaTournamentPointsGroupResultOrNull
          ? TE.right(
              prismaTournamentPointsGroupResultOrNull.map(
                mapPrismaTournamentPointsGroupResultToDomain,
              ),
            )
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Tournament points group result with tournament id ${tournamentId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentPointsGroupResultInputs: TournamentPointsGroupResultCreateInputs,
  ): TE.TaskEither<DBError, TournamentPointsGroupResults> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = tournamentPointsGroupResultInputs.map(
            mapDomainTournamentPointsGroupResultToPrismaCreate,
          );
          await prismaClient.tournamentPointsGroupResult.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament points group results in batch: ${error}`,
          }),
      ),
      TE.chain(() => findByTournamentId(tournamentPointsGroupResultInputs[0].tournamentId)),
    );

  return {
    findByTournamentId,
    saveBatchByTournamentId,
  };
};
