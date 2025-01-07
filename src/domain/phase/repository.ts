import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createDBError, DBErrorCode } from '../../types/error.type';
import {
  PhaseId,
  PhaseRepository,
  PrismaPhaseCreate,
  PrismaPhaseUpdate,
} from '../../types/phase.type';

export const createPhaseRepository = (prisma: PrismaClient): PhaseRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.phase.findMany({
            orderBy: {
              id: 'asc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all phases: ${error}`,
          }),
      ),
    ),

  findById: (id: PhaseId) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.phase.findUnique({
            where: {
              id: Number(id),
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch phase by id ${id}: ${error}`,
          }),
      ),
    ),

  findByIds: (ids: PhaseId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.phase.findMany({
            where: {
              id: {
                in: ids.map((id) => Number(id)),
              },
            },
            orderBy: {
              id: 'asc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch phases by ids: ${error}`,
          }),
      ),
    ),

  save: (data: PrismaPhaseCreate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.phase.create({
            data,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create phase: ${error}`,
          }),
      ),
    ),

  saveBatch: (data: PrismaPhaseCreate[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.phase.createMany({
            data,
            skipDuplicates: true,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create phases in batch: ${error}`,
          }),
      ),
      TE.chain(() =>
        pipe(
          TE.tryCatch(
            () =>
              prisma.phase.findMany({
                where: {
                  id: {
                    in: data.map((phase) => phase.id),
                  },
                },
                orderBy: {
                  id: 'asc',
                },
              }),
            (error) =>
              createDBError({
                code: DBErrorCode.QUERY_ERROR,
                message: `Failed to fetch created phases: ${error}`,
              }),
          ),
        ),
      ),
    ),

  update: (id: PhaseId, phase: PrismaPhaseUpdate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.phase.update({
            where: {
              id: Number(id),
            },
            data: phase,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to update phase ${id}: ${error}`,
          }),
      ),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.phase.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all phases: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),

  deleteByIds: (ids: readonly PhaseId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.phase.deleteMany({
            where: {
              id: {
                in: ids.map((id) => Number(id)),
              },
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete phases by ids: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),
});
