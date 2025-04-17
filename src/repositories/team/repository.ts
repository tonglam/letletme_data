import { PrismaClient } from '@prisma/client';
import { TeamRepository } from 'domains/team/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { mapDomainTeamToPrismaCreate, mapPrismaTeamToDomain } from 'src/repositories/team/mapper';
import { PrismaTeamCreate } from 'src/repositories/team/type';
import { TeamId } from 'src/types/domain/team.type';

import { createDBError, DBErrorCode } from '../../types/error.type';

export const createTeamRepository = (prismaClient: PrismaClient): TeamRepository => ({
  findAll: () =>
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
    ),

  findById: (id: TeamId) =>
    pipe(
      TE.tryCatch(
        () => prismaClient.team.findUnique({ where: { id: Number(id) } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch team by id ${id}: ${error}`,
          }),
      ),
      TE.map((prismaTeam) => (prismaTeam ? mapPrismaTeamToDomain(prismaTeam) : null)),
    ),

  saveBatch: (data: readonly PrismaTeamCreate[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = data.map(mapDomainTeamToPrismaCreate);
          await prismaClient.team.createMany({
            data: dataToCreate,
            skipDuplicates: true,
          });

          const ids = data.map((d) => Number(d.id));

          return prismaClient.team.findMany({
            where: { id: { in: ids } },
            orderBy: { id: 'asc' },
          });
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create teams in batch: ${error}`,
          }),
      ),
      TE.map((prismaTeams) => prismaTeams.map(mapPrismaTeamToDomain)),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prismaClient.team.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all teams: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),
});
