import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { ValueChangeType } from '../../types/base.type';
import { DBErrorCode, createDBError } from '../../types/error.type';
import {
  PlayerValueId,
  PlayerValueRepository,
  PrismaPlayerValue,
  PrismaPlayerValueCreate,
} from '../../types/player-value.type';

export const createPlayerValueRepository = (prisma: PrismaClient): PlayerValueRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to fetch all player values',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findById: (id: PlayerValueId) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findUnique({ where: { id } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player value by id: ${id}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findByIds: (ids: PlayerValueId[]) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { id: { in: ids } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by ids: ${ids.join(', ')}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findByChangeDate: (changeDate: string) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { changeDate } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by change date: ${changeDate}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findByElementId: (elementId: number) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            where: { elementId },
            orderBy: { changeDate: 'asc' },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by element id: ${elementId}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findByElementType: (elementType: number) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { elementType } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by element type: ${elementType}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findByChangeType: (changeType: ValueChangeType) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { changeType } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by change type: ${changeType}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findByEventId: (eventId: number) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.findMany({ where: { eventId } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player values by event id: ${eventId}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  findLatestByElements: () =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerValue.findMany({
            orderBy: [{ elementId: 'asc' }, { changeDate: 'desc' }],
            distinct: ['elementId'],
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to fetch latest player values',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  save: (data: PrismaPlayerValueCreate) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.create({ data }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to create player value',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  saveBatch: (data: PrismaPlayerValueCreate[]) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.createMany({ data }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to create player values',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain(() =>
        pipe(
          TE.tryCatch(
            () =>
              prisma.playerValue.findMany({
                where: {
                  OR: data.map((d) => ({
                    elementId: d.elementId,
                    changeDate: d.changeDate,
                  })),
                },
              }),
            (error) =>
              createDBError({
                code: DBErrorCode.QUERY_ERROR,
                message: 'Failed to fetch created player values',
                cause: error instanceof Error ? error : new Error(String(error)),
              }),
          ),
        ),
      ),
    ),

  update: (id: PlayerValueId, data: PrismaPlayerValue) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.update({ where: { id }, data }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to update player value: ${id}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.deleteMany(),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: 'Failed to delete all player values',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.map(() => undefined),
    ),

  deleteByIds: (ids: PlayerValueId[]) =>
    pipe(
      TE.tryCatch(
        () => prisma.playerValue.deleteMany({ where: { id: { in: ids } } }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete player values by ids: ${ids.join(', ')}`,
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.map(() => undefined),
    ),
});
