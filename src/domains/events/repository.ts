// Event Repository Module
// Provides data access operations for the Event entity using Prisma ORM.
// Implements repository pattern with functional programming principles,
// ensuring type-safe database operations and consistent error handling.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { prisma } from '../../infrastructure/db/prisma';
import { DBError } from '../../types/errors.type';
import {
  EventId,
  EventRepository,
  PrismaEvent,
  PrismaEventCreate,
  PrismaEventUpdate,
} from '../../types/events.type';
import { handlePrismaError } from '../../utils/error.util';
import { transformJsonFields } from '../../utils/prisma.util';

const JSON_FIELDS: Array<keyof Pick<PrismaEventCreate, 'chipPlays' | 'topElementInfo'>> = [
  'chipPlays',
  'topElementInfo',
];

// Event repository implementation
export const eventRepository: EventRepository = {
  findAll: (): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(TE.tryCatch(() => prisma.event.findMany(), handlePrismaError)),

  findById: (id: EventId): TE.TaskEither<DBError, PrismaEvent | null> =>
    pipe(TE.tryCatch(() => prisma.event.findUnique({ where: { id } }), handlePrismaError)),

  findByIds: (ids: EventId[]): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findMany({
            where: { id: { in: ids } },
          }),
        handlePrismaError,
      ),
    ),

  findCurrent: (): TE.TaskEither<DBError, PrismaEvent | null> =>
    pipe(
      TE.tryCatch(() => prisma.event.findFirst({ where: { isCurrent: true } }), handlePrismaError),
    ),

  findNext: (): TE.TaskEither<DBError, PrismaEvent | null> =>
    pipe(TE.tryCatch(() => prisma.event.findFirst({ where: { isNext: true } }), handlePrismaError)),

  save: (event: PrismaEventCreate): TE.TaskEither<DBError, PrismaEvent> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.create({
            data: transformJsonFields(event, JSON_FIELDS),
          }),
        handlePrismaError,
      ),
    ),

  saveBatch: (events: PrismaEventCreate[]): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.createMany({
            data: events.map((event) => transformJsonFields(event, JSON_FIELDS)),
          }),
        handlePrismaError,
      ),
      TE.chain(() =>
        pipe(
          TE.tryCatch(
            () =>
              prisma.event.findMany({
                where: { id: { in: events.map((e) => e.id) } },
              }),
            handlePrismaError,
          ),
        ),
      ),
    ),

  update: (id: EventId, event: PrismaEventUpdate): TE.TaskEither<DBError, PrismaEvent> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.update({
            where: { id },
            data: transformJsonFields(event, JSON_FIELDS),
          }),
        handlePrismaError,
      ),
    ),

  deleteAll: (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(() => prisma.event.deleteMany(), handlePrismaError),
      TE.map(() => undefined),
    ),

  deleteByIds: (ids: EventId[]): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.deleteMany({
            where: { id: { in: ids } },
          }),
        handlePrismaError,
      ),
      TE.map(() => undefined),
    ),
};
