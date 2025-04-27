import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  TournamentGroupCreateInputs,
  TournamentGroupRepository,
} from 'src/repositories/tournament-group/types';
import { TournamentGroups } from 'src/types/domain/tournament-group.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

import { mapDomainTournamentGroupToPrismaCreate, mapPrismaTournamentGroupToDomain } from './mapper';
import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createTournamentGroupRepository = (
  prismaClient: PrismaClient,
): TournamentGroupRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentGroups> =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.tournamentGroup.findMany({
            where: { tournamentId: Number(tournamentId) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament group by tournament id ${tournamentId}: ${error}`,
          }),
      ),
      TE.chainW((prismaTournamentGroupOrNull) =>
        prismaTournamentGroupOrNull
          ? TE.right(prismaTournamentGroupOrNull.map(mapPrismaTournamentGroupToDomain))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Tournament group with tournament id ${tournamentId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentGroupInputs: TournamentGroupCreateInputs,
  ): TE.TaskEither<DBError, TournamentGroups> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = tournamentGroupInputs.map(mapDomainTournamentGroupToPrismaCreate);
          await prismaClient.tournamentGroup.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament groups in batch: ${error}`,
          }),
      ),
      TE.chain(() => findByTournamentId(tournamentGroupInputs[0].tournamentId)),
    );

  return {
    findByTournamentId,
    saveBatchByTournamentId,
  };
};
