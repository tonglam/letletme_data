/**
 * Event Repository Module
 *
 * Provides data access operations for the Event entity using Prisma ORM.
 * Implements repository pattern with functional programming principles,
 * ensuring type-safe database operations and consistent error handling.
 *
 * @module EventRepository
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { prisma } from '../../infrastructure/db/prisma';
import { toNullableJson } from '../../infrastructure/db/utils';
import {
  EventId,
  EventRepository,
  PrismaEvent,
  PrismaEventCreate,
  PrismaEventUpdate,
} from '../../types/domain/events.type';
import { APIError, APIErrorCode, createAPIError } from '../../types/errors.type';

/**
 * Creates a database error
 */
const createDatabaseError = (error: unknown): APIError =>
  createAPIError({
    code: APIErrorCode.INTERNAL_SERVER_ERROR,
    message: 'Database operation failed',
    details: error,
  });

/**
 * Event repository implementation
 */
export const eventRepository: EventRepository = {
  prisma,

  findAll: (): TE.TaskEither<APIError, PrismaEvent[]> =>
    pipe(TE.tryCatch(() => prisma.event.findMany(), createDatabaseError)),

  findById: (id: EventId): TE.TaskEither<APIError, PrismaEvent | null> =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findUnique({ where: { id: Number(id) } }),
        createDatabaseError,
      ),
    ),

  findByIds: (ids: EventId[]): TE.TaskEither<APIError, PrismaEvent[]> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findMany({
            where: { id: { in: ids.map((id) => Number(id)) } },
          }),
        createDatabaseError,
      ),
    ),

  findCurrent: (): TE.TaskEither<APIError, PrismaEvent | null> =>
    pipe(
      TE.tryCatch(
        () => prisma.event.findFirst({ where: { isCurrent: true } }),
        createDatabaseError,
      ),
    ),

  findNext: (): TE.TaskEither<APIError, PrismaEvent | null> =>
    pipe(
      TE.tryCatch(() => prisma.event.findFirst({ where: { isNext: true } }), createDatabaseError),
    ),

  save: (event: PrismaEventCreate): TE.TaskEither<APIError, PrismaEvent> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.create({
            data: {
              ...event,
              chipPlays: toNullableJson(event.chipPlays),
              topElementInfo: toNullableJson(event.topElementInfo),
            },
          }),
        createDatabaseError,
      ),
    ),

  saveBatch: (events: PrismaEventCreate[]): TE.TaskEither<APIError, PrismaEvent[]> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.createMany({
            data: events.map((event) => ({
              ...event,
              chipPlays: toNullableJson(event.chipPlays),
              topElementInfo: toNullableJson(event.topElementInfo),
            })),
          }),
        createDatabaseError,
      ),
      TE.chain(() =>
        pipe(
          TE.tryCatch(
            () =>
              prisma.event.findMany({
                where: { id: { in: events.map((e) => Number(e.id)) } },
              }),
            createDatabaseError,
          ),
        ),
      ),
    ),

  update: (id: EventId, event: PrismaEventUpdate): TE.TaskEither<APIError, PrismaEvent> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.update({
            where: { id: Number(id) },
            data: {
              ...event,
              chipPlays: toNullableJson(event.chipPlays),
              topElementInfo: toNullableJson(event.topElementInfo),
            },
          }),
        createDatabaseError,
      ),
    ),

  deleteAll: (): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(() => prisma.event.deleteMany(), createDatabaseError),
      TE.map(() => undefined),
    ),

  deleteByIds: (ids: EventId[]): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.deleteMany({
            where: { id: { in: ids.map((id) => Number(id)) } },
          }),
        createDatabaseError,
      ),
      TE.map(() => undefined),
    ),
};
