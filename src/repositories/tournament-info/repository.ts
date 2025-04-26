import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapPrismaTournamentInfoToDomain } from 'src/repositories/tournament-info/mapper';
import { TournamentInfoRepository } from 'src/repositories/tournament-info/types';
import { TournamentInfo, TournamentInfos } from 'src/types/domain/tournament-info.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { DBError, DBErrorCode } from 'src/types/error.type';
import { createDBError } from 'src/types/error.type';

export const createTournamentInfoRepository = (
  prismaClient: PrismaClient,
): TournamentInfoRepository => {
  const findById = (id: TournamentId): TE.TaskEither<DBError, TournamentInfo> =>
    pipe(
      TE.tryCatch(
        () => prismaClient.tournamentInfo.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch tournament info by id ${id}: ${error}`,
          }),
      ),
      TE.chainW((prismaTournamentInfoOrNull) =>
        prismaTournamentInfoOrNull
          ? TE.right(mapPrismaTournamentInfoToDomain(prismaTournamentInfoOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Tournament info with id ${id} not found in database`,
              }),
            ),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, TournamentInfos> =>
    pipe(
      TE.tryCatch(
        () => prismaClient.tournamentInfo.findMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all tournament ids: ${error}`,
          }),
      ),
      TE.chainW((prismaTournamentInfos) =>
        TE.right(prismaTournamentInfos.map(mapPrismaTournamentInfoToDomain)),
      ),
    );

  return { findById, findAll };
};
