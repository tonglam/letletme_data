import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainTournamentEntryToPrismaCreate,
  mapPrismaTournamentEntryToDomain,
} from 'src/repositories/tournament-entry/mapper';
import {
  TournamentEntryCreateInputs,
  TournamentEntryRepository,
} from 'src/repositories/tournament-entry/types';
import { TournamentEntries } from 'src/types/domain/tournament-entry.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createTournamentEntryRepository = (
  prismaClient: PrismaClient,
): TournamentEntryRepository => {
  const findByTournamentId = (
    tournamentId: TournamentId,
  ): TE.TaskEither<DBError, TournamentEntries> =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.tournamentEntry.findMany({
            where: { tournamentId: Number(tournamentId) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament entry by tournament id ${tournamentId}: ${error}`,
          }),
      ),
      TE.chainW((prismaTournamentEntryOrNull) =>
        prismaTournamentEntryOrNull
          ? TE.right(prismaTournamentEntryOrNull.map(mapPrismaTournamentEntryToDomain))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Tournament entry with tournament id ${tournamentId} not found in database`,
              }),
            ),
      ),
    );

  const saveBatchByTournamentId = (
    tournamentEntryInputs: TournamentEntryCreateInputs,
  ): TE.TaskEither<DBError, TournamentEntries> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = tournamentEntryInputs.map(mapDomainTournamentEntryToPrismaCreate);
          await prismaClient.tournamentEntry.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create tournament entries in batch: ${error}`,
          }),
      ),
      TE.chain(() => findByTournamentId(tournamentEntryInputs[0].tournamentId)),
    );

  return {
    findByTournamentId,
    saveBatchByTournamentId,
  };
};
