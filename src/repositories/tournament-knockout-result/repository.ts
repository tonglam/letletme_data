import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  TournamentKnockoutResultCreateInputs,
  TournamentKnockoutResultRepository,
} from 'src/repositories/tournament-knockout-result/types';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { TournamentKnockoutResults } from 'src/types/domain/tournament-knockout-result.type';

import {
  mapDomainTournamentKnockoutResultToPrismaCreate,
  mapPrismaTournamentKnockoutResultToDomain,
} from './mapper';
import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createTournamentKnockoutResultRepository = (
  prismaClient: PrismaClient,
): TournamentKnockoutResultRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentKnockoutResults> =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.tournamentKnockoutResult.findMany({
            where: { tournamentId: Number(tournamentId) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament knockout result by tournament id ${tournamentId}: ${error}`,
          }),
      ),
      TE.chainW((prismaTournamentKnockoutResultOrNull) =>
        prismaTournamentKnockoutResultOrNull
          ? TE.right(
              prismaTournamentKnockoutResultOrNull.map(mapPrismaTournamentKnockoutResultToDomain),
            )
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Tournament knockout result with tournament id ${tournamentId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentKnockoutResultInputs: TournamentKnockoutResultCreateInputs,
  ): TE.TaskEither<DBError, TournamentKnockoutResults> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = tournamentKnockoutResultInputs.map(
            mapDomainTournamentKnockoutResultToPrismaCreate,
          );
          await prismaClient.tournamentKnockoutResult.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament knockout results in batch: ${error}`,
          }),
      ),
      TE.chain(() => findByTournamentId(tournamentKnockoutResultInputs[0].tournamentId)),
    );

  return {
    findByTournamentId,
    saveBatchByTournamentId,
  };
};
