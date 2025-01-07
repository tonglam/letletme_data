// Event Repository Module
// Provides data access operations for the Event entity using Prisma ORM.
// Implements repository pattern with functional programming principles,
// ensuring type-safe database operations and consistent error handling.

import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { prisma } from '../../infrastructure/db/prisma';
import { DBError, DBErrorCode } from '../../types/error.type';
import {
  ChipPlay,
  Event,
  EventId,
  PrismaEvent,
  PrismaEventCreate,
  TopElementInfo,
  toPrismaEvent,
  validateEventId,
} from '../../types/event.type';
import { handlePrismaError } from '../../utils/error.util';
import { EventRepositoryOperations } from './types';

const createDBError = (message: string): DBError => ({
  code: 'PRISMA_ERROR' as DBErrorCode,
  name: 'DatabaseError',
  message,
  timestamp: new Date(),
});

const toPrismaCreateInput = (data: PrismaEventCreate): Prisma.EventCreateInput => ({
  id: data.id,
  name: data.name,
  deadlineTime: data.deadlineTime,
  deadlineTimeEpoch: data.deadlineTimeEpoch,
  deadlineTimeGameOffset: data.deadlineTimeGameOffset,
  releaseTime: data.releaseTime,
  averageEntryScore: data.averageEntryScore,
  finished: data.finished,
  dataChecked: data.dataChecked,
  highestScore: data.highestScore,
  highestScoringEntry: data.highestScoringEntry,
  isPrevious: data.isPrevious,
  isCurrent: data.isCurrent,
  isNext: data.isNext,
  cupLeaguesCreated: data.cupLeaguesCreated,
  h2hKoMatchesCreated: data.h2hKoMatchesCreated,
  rankedCount: data.rankedCount,
  chipPlays: data.chipPlays as Prisma.InputJsonValue,
  mostSelected: data.mostSelected,
  mostTransferredIn: data.mostTransferredIn,
  mostCaptained: data.mostCaptained,
  mostViceCaptained: data.mostViceCaptained,
  topElement: data.topElement,
  topElementInfo: data.topElementInfo as Prisma.InputJsonValue,
  transfersMade: data.transfersMade,
});

const parseChipPlays = (data: Prisma.JsonValue | null): readonly ChipPlay[] => {
  if (!data || !Array.isArray(data)) return [];
  return data.map((item) => {
    if (typeof item !== 'object' || item === null) {
      return { chip_name: '', num_played: 0 };
    }
    const obj = item as Record<string, unknown>;
    return {
      chip_name: String(obj.chip_name || ''),
      num_played: Number(obj.num_played || 0),
    };
  });
};

const parseTopElementInfo = (data: Prisma.JsonValue | null): TopElementInfo | null => {
  if (!data || typeof data !== 'object' || data === null) return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.id !== 'number' || typeof obj.points !== 'number') return null;
  return { id: obj.id, points: obj.points };
};

const toEvent = (data: PrismaEvent): E.Either<string, Event> => {
  const eventId = validateEventId(data.id);
  if (E.isLeft(eventId)) return eventId;

  return E.right({
    id: eventId.right,
    name: data.name,
    deadlineTime: data.deadlineTime,
    deadlineTimeEpoch: data.deadlineTimeEpoch,
    deadlineTimeGameOffset: data.deadlineTimeGameOffset,
    releaseTime: data.releaseTime,
    averageEntryScore: data.averageEntryScore,
    finished: data.finished,
    dataChecked: data.dataChecked,
    highestScore: data.highestScore,
    highestScoringEntry: data.highestScoringEntry,
    isPrevious: data.isPrevious,
    isCurrent: data.isCurrent,
    isNext: data.isNext,
    cupLeaguesCreated: data.cupLeaguesCreated,
    h2hKoMatchesCreated: data.h2hKoMatchesCreated,
    rankedCount: data.rankedCount,
    chipPlays: parseChipPlays(data.chipPlays),
    mostSelected: data.mostSelected,
    mostTransferredIn: data.mostTransferredIn,
    mostCaptained: data.mostCaptained,
    mostViceCaptained: data.mostViceCaptained,
    topElement: data.topElement,
    topElementInfo: parseTopElementInfo(data.topElementInfo),
    transfersMade: data.transfersMade,
  });
};

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
      toPrismaEvent(event),
      TE.fromEither,
      TE.mapLeft(createDBError),
      TE.chain((data) =>
        TE.tryCatch(
          () =>
            prisma.event.create({
              data: toPrismaCreateInput(data),
            }),
          handlePrismaError,
        ),
      ),
    ),

  createMany: (events: readonly Event[]): TE.TaskEither<DBError, PrismaEvent[]> =>
    pipe(
      events,
      TE.traverseArray((event) =>
        pipe(toPrismaEvent(event), TE.fromEither, TE.mapLeft(createDBError)),
      ),
      TE.chain((prismaEvents) =>
        pipe(
          TE.tryCatch(
            () =>
              prisma.event.createMany({
                data: prismaEvents.map(toPrismaCreateInput),
              }),
            handlePrismaError,
          ),
          TE.chain(() =>
            TE.tryCatch(
              () =>
                prisma.event.findMany({
                  where: { id: { in: prismaEvents.map((e) => e.id) } },
                  orderBy: { id: 'asc' },
                }),
              handlePrismaError,
            ),
          ),
        ),
      ),
    ),

  update: (id: EventId, event: Partial<Event>): TE.TaskEither<DBError, PrismaEvent> =>
    pipe(
      TE.Do,
      TE.bind('current', () =>
        TE.tryCatch(
          () => prisma.event.findUnique({ where: { id: Number(id) } }),
          handlePrismaError,
        ),
      ),
      TE.chain(({ current }) => {
        if (!current) {
          return TE.left(createDBError(`Event with id ${id} not found`));
        }
        return pipe(
          toEvent(current),
          E.map((currentEvent) => ({ ...currentEvent, ...event })),
          TE.fromEither,
          TE.mapLeft(createDBError),
          TE.chain((merged) =>
            pipe(
              toPrismaEvent(merged),
              TE.fromEither,
              TE.mapLeft(createDBError),
              TE.chain((data) =>
                TE.tryCatch(
                  () =>
                    prisma.event.update({
                      where: { id: Number(id) },
                      data: toPrismaCreateInput(data),
                    }),
                  handlePrismaError,
                ),
              ),
            ),
          ),
        );
      }),
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
