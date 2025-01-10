import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createDBError, DBErrorCode } from '../../types/error.type';
import { PrismaTeam, PrismaTeamCreate, TeamId, TeamRepository } from '../../types/team.type';

export const createTeamRepository = (prismaClient: PrismaClient): TeamRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.team.findMany({
            orderBy: { id: 'asc' },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all teams: ${error}`,
          }),
      ),
    ),

  findById: (id: TeamId) =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.team.findUnique({
            where: { id: Number(id) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch team ${id}: ${error}`,
          }),
      ),
    ),

  findByIds: (ids: TeamId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.team.findMany({
            where: { id: { in: ids.map(Number) } },
            orderBy: { id: 'asc' },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch teams by ids: ${error}`,
          }),
      ),
    ),

  save: (data: PrismaTeamCreate) =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.team.create({
            data,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create team: ${error}`,
          }),
      ),
    ),

  saveBatch: (data: PrismaTeamCreate[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.team.createMany({
            data,
            skipDuplicates: true,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create teams: ${error}`,
          }),
      ),
      TE.chain(() =>
        pipe(
          TE.tryCatch(
            () =>
              prismaClient.team.findMany({
                where: { id: { in: data.map((e) => e.id) } },
                orderBy: { id: 'asc' },
              }),
            (error) =>
              createDBError({
                code: DBErrorCode.QUERY_ERROR,
                message: `Failed to fetch created teams: ${error}`,
              }),
          ),
        ),
      ),
    ),

  update: (id: TeamId, data: Partial<PrismaTeam>) =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.team.update({
            where: { id: Number(id) },
            data,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to update team ${id}: ${error}`,
          }),
      ),
    ),

  deleteByIds: (ids: TeamId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prismaClient.team.deleteMany({
            where: { id: { in: ids.map(Number) } },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete teams by ids: ${error}`,
          }),
      ),
      TE.map(() => undefined),
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
      TE.map(() => undefined),
    ),
});
