import { PrismaClient } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDomainTeamToPrismaCreate, mapPrismaTeamToDomain } from 'src/repositories/team/mapper';
import { TeamCreateInputs, TeamRepository } from 'src/repositories/team/types';
import { Team, TeamId, Teams } from 'src/types/domain/team.type';

import { createDBError, DBError, DBErrorCode } from '../../types/error.type';

export const createTeamRepository = (prismaClient: PrismaClient): TeamRepository => {
  const findById = (id: TeamId): TE.TaskEither<DBError, Team> =>
    pipe(
      TE.tryCatch(
        () => prismaClient.team.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch team by id ${id}: ${error}`,
          }),
      ),
      TE.chainW((prismaTeamOrNull) =>
        prismaTeamOrNull
          ? TE.right(mapPrismaTeamToDomain(prismaTeamOrNull))
          : TE.left(
              createDBError({
                code: DBErrorCode.NOT_FOUND,
                message: `Team with ID ${id} not found in database`,
              }),
            ),
      ),
    );

  const findAll = (): TE.TaskEither<DBError, Teams> =>
    pipe(
      TE.tryCatch(
        () => prismaClient.team.findMany({ orderBy: { id: 'asc' } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all teams: ${error}`,
          }),
      ),
      TE.map((prismaTeams) => prismaTeams.map(mapPrismaTeamToDomain)),
    );

  const saveBatch = (teamInputs: TeamCreateInputs): TE.TaskEither<DBError, Teams> =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = teamInputs.map(mapDomainTeamToPrismaCreate);
          await prismaClient.team.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create teams in batch: ${error}`,
          }),
      ),
      TE.chain(() => findAll()),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () => prismaClient.team.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all teams: ${error}`,
          }),
      ),
      TE.map(() => undefined),
    );

  return {
    findById,
    findAll,
    saveBatch,
    deleteAll,
  };
};
