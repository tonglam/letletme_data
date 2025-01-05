// Event Repository Module
// Provides data access operations for the Event entity using Prisma ORM.
// Implements repository pattern with functional programming principles,
// ensuring type-safe database operations and consistent error handling.

import { Prisma } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { prisma } from '../../infrastructure/db/prisma';
import { DBError } from '../../types/errors.type';
import { Event, EventId, PrismaEvent } from '../../types/events.type';
import { handlePrismaError } from '../../utils/error.util';
import { EventRepositoryOperations } from './types';

const toPrismaCreateInput = (event: Event): Prisma.EventCreateInput => ({
  id: Number(event.id),
  name: event.name,
  deadlineTime: event.deadlineTime,
  deadlineTimeEpoch: event.deadlineTimeEpoch,
  deadlineTimeGameOffset: event.deadlineTimeGameOffset,
  releaseTime: event.releaseTime,
  averageEntryScore: event.averageEntryScore,
  finished: event.finished,
  dataChecked: event.dataChecked,
  highestScore: event.highestScore,
  highestScoringEntry: event.highestScoringEntry,
  isPrevious: event.isPrevious,
  isCurrent: event.isCurrent,
  isNext: event.isNext,
  cupLeaguesCreated: event.cupLeaguesCreated,
  h2hKoMatchesCreated: event.h2hKoMatchesCreated,
  rankedCount: event.rankedCount,
  chipPlays: event.chipPlays.length > 0 ? JSON.parse(JSON.stringify(event.chipPlays)) : undefined,
  mostSelected: event.mostSelected,
  mostTransferredIn: event.mostTransferredIn,
  mostCaptained: event.mostCaptained,
  mostViceCaptained: event.mostViceCaptained,
  topElement: event.topElement,
  topElementInfo: event.topElementInfo
    ? JSON.parse(JSON.stringify(event.topElementInfo))
    : undefined,
  transfersMade: event.transfersMade,
});

// Event repository implementation
export const eventRepository: EventRepositoryOperations = {
  findAll: (): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findMany({
            orderBy: { id: 'asc' },
          }),
        handlePrismaError,
      ),
    ),

  findById: (id: EventId): TE.TaskEither<DBError, PrismaEvent | null> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findUnique({
            where: { id: Number(id) },
          }),
        handlePrismaError,
      ),
    ),

  findByIds: (ids: EventId[]): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findMany({
            where: { id: { in: ids.map(Number) } },
            orderBy: { id: 'asc' },
          }),
        handlePrismaError,
      ),
    ),

  findCurrent: (): TE.TaskEither<DBError, PrismaEvent | null> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findFirst({
            where: { isCurrent: true },
          }),
        handlePrismaError,
      ),
    ),

  findNext: (): TE.TaskEither<DBError, PrismaEvent | null> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.findFirst({
            where: { isNext: true },
          }),
        handlePrismaError,
      ),
    ),

  create: (event: Event): TE.TaskEither<DBError, PrismaEvent> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.create({
            data: toPrismaCreateInput(event),
          }),
        handlePrismaError,
      ),
    ),

  createMany: (events: readonly Event[]): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.createMany({
            data: events.map(toPrismaCreateInput),
          }),
        handlePrismaError,
      ),
      TE.chain(() =>
        pipe(
          TE.tryCatch(
            () =>
              prisma.event.findMany({
                where: { id: { in: events.map((e) => Number(e.id)) } },
                orderBy: { id: 'asc' },
              }),
            handlePrismaError,
          ),
        ),
      ),
    ),

  update: (id: EventId, event: Partial<Event>): TE.TaskEither<DBError, PrismaEvent> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.update({
            where: { id: Number(id) },
            data: {
              name: event.name,
              deadlineTime: event.deadlineTime,
              deadlineTimeEpoch: event.deadlineTimeEpoch,
              deadlineTimeGameOffset: event.deadlineTimeGameOffset,
              releaseTime: event.releaseTime,
              averageEntryScore: event.averageEntryScore,
              finished: event.finished,
              dataChecked: event.dataChecked,
              highestScore: event.highestScore,
              highestScoringEntry: event.highestScoringEntry,
              isPrevious: event.isPrevious,
              isCurrent: event.isCurrent,
              isNext: event.isNext,
              cupLeaguesCreated: event.cupLeaguesCreated,
              h2hKoMatchesCreated: event.h2hKoMatchesCreated,
              rankedCount: event.rankedCount,
              chipPlays: event.chipPlays ? JSON.parse(JSON.stringify(event.chipPlays)) : undefined,
              mostSelected: event.mostSelected,
              mostTransferredIn: event.mostTransferredIn,
              mostCaptained: event.mostCaptained,
              mostViceCaptained: event.mostViceCaptained,
              topElement: event.topElement,
              topElementInfo: event.topElementInfo
                ? JSON.parse(JSON.stringify(event.topElementInfo))
                : undefined,
              transfersMade: event.transfersMade,
            },
          }),
        handlePrismaError,
      ),
    ),

  delete: (id: EventId): TE.TaskEither<DBError, PrismaEvent> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.delete({
            where: { id: Number(id) },
          }),
        handlePrismaError,
      ),
    ),

  deleteAll: (): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(() => prisma.event.deleteMany({}), handlePrismaError),
      TE.map(() => undefined),
    ),
};
