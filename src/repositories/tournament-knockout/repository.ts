import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainTournamentKnockoutToPrismaCreate,
  mapPrismaTournamentKnockoutToDomain,
} from 'src/repositories/tournament-knockout/mapper';
import {
  TournamentKnockoutCreateInputs,
  TournamentKnockoutRepository,
} from 'src/repositories/tournament-knockout/types';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { TournamentKnockouts } from 'src/types/domain/tournament-knockout.type';

import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createTournamentKnockoutRepository = (
  prismaClient: PrismaClient,
): TournamentKnockoutRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentKnockouts> =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.tournamentKnockout.findMany({
            where: { tournamentId: Number(tournamentId) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament knockout by tournament id ${tournamentId}: ${error}`,
          }),
      ),
      TE.chainW((prismaTournamentKnockoutOrNull) =>
        prismaTournamentKnockoutOrNull
          ? TE.right(prismaTournamentKnockoutOrNull.map(mapPrismaTournamentKnockoutToDomain))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Tournament knockout with tournament id ${tournamentId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentKnockoutInputs: TournamentKnockoutCreateInputs,
  ): TE.TaskEither<DBError, TournamentKnockouts> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = tournamentKnockoutInputs.map(
            mapDomainTournamentKnockoutToPrismaCreate,
          );
          await prismaClient.tournamentKnockout.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament knockouts in batch: ${error}`,
          }),
      ),
      TE.chain(() => findByTournamentId(tournamentKnockoutInputs[0].tournamentId)),
    );

  return {
    findByTournamentId,
    saveBatchByTournamentId,
  };
};
