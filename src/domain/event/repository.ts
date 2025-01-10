// Event Repository Module
// Provides data access operations for the Event entity using Prisma ORM.
// Implements repository pattern with functional programming principles,
// ensuring type-safe database operations and consistent error handling.

import { Prisma, PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createDBError, DBErrorCode } from '../../types/error.type';
import {
  EventId,
  EventRepository,
  PrismaEventCreate,
  PrismaEventUpdate,
} from '../../types/event.type';

const toPrismaCreateInput = (data: PrismaEventCreate): Prisma.EventCreateInput => ({
  ...data,
  chipPlays: data.chipPlays as Prisma.InputJsonValue,
  topElementInfo: data.topElementInfo as Prisma.InputJsonValue,
});

const toPrismaUpdateInput = (data: PrismaEventUpdate): Prisma.EventUpdateInput => ({
  ...data,
  chipPlays: data.chipPlays as Prisma.InputJsonValue,
  topElementInfo: data.topElementInfo as Prisma.InputJsonValue,
});

export const createEventRepository = (prisma: PrismaClient): EventRepository => ({
  findAll: () =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findMany({
            orderBy: { id: 'asc' },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch all events: ${error}`,
          }),
      ),
    ),

  findById: (id: EventId) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findUnique({
            where: { id: Number(id) },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event by id ${id}: ${error}`,
          }),
      ),
    ),

  findByIds: (ids: EventId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findMany({
            where: { id: { in: ids.map(Number) } },
            orderBy: { id: 'asc' },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch events by ids: ${error}`,
          }),
      ),
    ),

  findCurrent: () =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findFirst({
            where: { isCurrent: true },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch current event: ${error}`,
          }),
      ),
    ),

  findNext: () =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findFirst({
            where: { isNext: true },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch next event: ${error}`,
          }),
      ),
    ),

  save: (data: PrismaEventCreate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.create({
            data: toPrismaCreateInput(data),
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create event: ${error}`,
          }),
      ),
    ),

  saveBatch: (events: PrismaEventCreate[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.createMany({
            data: events.map((e) => ({
              ...e,
              chipPlays: e.chipPlays as Prisma.InputJsonValue,
              topElementInfo: e.topElementInfo as Prisma.InputJsonValue,
            })),
            skipDuplicates: true,
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create events in batch: ${error}`,
          }),
      ),
      TE.chain(() =>
        TE.tryCatch(
          () =>
            prisma.event.findMany({
              where: {
                id: {
                  in: events.map((e) => e.id),
                },
              },
              orderBy: {
                id: 'asc',
              },
            }),
          (error) =>
            createDBError({
              code: DBErrorCode.QUERY_ERROR,
              message: `Failed to fetch created events: ${error}`,
            }),
        ),
      ),
    ),

  update: (id: EventId, event: PrismaEventUpdate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.update({
            where: { id: Number(id) },
            data: toPrismaUpdateInput(event),
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to update event ${id}: ${error}`,
          }),
      ),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.event.deleteMany({}),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete all events: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),

  deleteByIds: (ids: EventId[]) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.deleteMany({
            where: { id: { in: ids.map(Number) } },
          }),
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete events by ids: ${error}`,
          }),
      ),
      TE.map(() => void 0),
    ),
});
