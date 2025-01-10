import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DBErrorCode, createDBError } from '../../types/error.type';
import {
  PlayerStatId,
  PlayerStatRepository,
  PrismaPlayerStatCreate,
  PrismaPlayerStatUpdate,
} from '../../types/player-stat.type';

export const createPlayerStatRepository = (prisma: PrismaClient): PlayerStatRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.findMany({
            orderBy: {
              eventId: 'desc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all player stats: ${error}`,
          }),
      ),
    ),

  findById: (id: PlayerStatId) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.findUnique({
            where: {
              id: id,
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player stat by id ${id}: ${error}`,
          }),
      ),
    ),

  findByIds: (ids: PlayerStatId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.findMany({
            where: {
              id: {
                in: [...ids],
              },
            },
            orderBy: {
              eventId: 'desc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player stats by ids: ${error}`,
          }),
      ),
    ),

  findByEventId: (eventId: number) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.findMany({
            where: {
              eventId,
            },
            orderBy: {
              elementId: 'asc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player stats by event id ${eventId}: ${error}`,
          }),
      ),
    ),

  findByElementId: (elementId: number) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.findMany({
            where: {
              elementId,
            },
            orderBy: {
              eventId: 'desc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player stats by element id ${elementId}: ${error}`,
          }),
      ),
    ),

  findByTeamId: (teamId: number) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.findMany({
            where: {
              teamId,
            },
            orderBy: {
              eventId: 'desc',
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch player stats by team id ${teamId}: ${error}`,
          }),
      ),
    ),

  save: (data: PrismaPlayerStatCreate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.upsert({
            where: {
              unique_event_element: {
                eventId: data.eventId,
                elementId: data.elementId,
              },
            },
            update: data,
            create: data,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create player stat: ${error}`,
          }),
      ),
    ),

  saveBatch: (data: PrismaPlayerStatCreate[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.createMany({
            data,
            skipDuplicates: true,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create player stats in batch: ${error}`,
          }),
      ),
      TE.chain(() =>
        pipe(
          TE.tryCatch(
            () =>
              prisma.playerStat.findMany({
                where: {
                  elementId: {
                    in: data.map((stat) => stat.elementId),
                  },
                  eventId: {
                    in: data.map((stat) => stat.eventId),
                  },
                },
                orderBy: {
                  eventId: 'desc',
                },
              }),
            (error) =>
              createDBError({
                code: DBErrorCode.QUERY_ERROR,
                message: `Failed to fetch created player stats: ${error}`,
              }),
          ),
        ),
      ),
    ),

  update: (id: PlayerStatId, playerStat: PrismaPlayerStatUpdate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.update({
            where: {
              id,
            },
            data: playerStat,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to update player stat ${id}: ${error}`,
          }),
      ),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.playerStat.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all player stats: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),

  deleteByIds: (ids: PlayerStatId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.playerStat.deleteMany({
            where: {
              id: {
                in: [...ids],
              },
            },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete player stats by ids: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),
});
