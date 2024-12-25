import { Prisma } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { APIError, createDatabaseError } from '../../infrastructure/api/common/errors';
import { prisma } from '../../infrastructure/db/prisma';
import {
  EventId,
  EventRepository,
  PrismaEvent,
  PrismaEventCreate,
  PrismaEventUpdate,
} from '../../types/events.type';

/**
 * Event repository implementation
 * Provides data access operations for Event entity
 */
export const eventRepository: EventRepository = {
  prisma,
  /**
   * Creates a new event
   * @param event - The event data to create
   * @returns TaskEither with created event or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  save: (event: PrismaEventCreate): TE.TaskEither<APIError, PrismaEvent> =>
    TE.tryCatch(
      () => {
        const data = {
          ...event,
          highestScore: event.highestScore ?? undefined,
          highestScoringEntry: event.highestScoringEntry ?? undefined,
          mostSelected: event.mostSelected ?? undefined,
          mostTransferredIn: event.mostTransferredIn ?? undefined,
          mostCaptained: event.mostCaptained ?? undefined,
          mostViceCaptained: event.mostViceCaptained ?? undefined,
          topElement: event.topElement ?? undefined,
          createdAt: event.createdAt ?? new Date(),
        };
        return prisma.event.upsert({
          where: { id: Number(event.id) },
          update: data,
          create: data,
        });
      },
      (error) => createDatabaseError({ message: 'Failed to save event', details: { error } }),
    ),

  /**
   * Finds an event by its ID
   * @param id - The event ID to find
   * @returns TaskEither with found event or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findById: (id: EventId): TE.TaskEither<APIError, PrismaEvent | null> =>
    TE.tryCatch(
      () =>
        prisma.event.findUnique({
          where: { id: Number(id) },
        }),
      (error) => createDatabaseError({ message: 'Failed to find event', details: { error } }),
    ),

  /**
   * Retrieves all events ordered by id
   * @returns TaskEither with array of events or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findAll: (): TE.TaskEither<APIError, PrismaEvent[]> =>
    TE.tryCatch(
      () =>
        prisma.event.findMany({
          orderBy: { id: 'asc' },
        }),
      (error) => createDatabaseError({ message: 'Failed to find events', details: { error } }),
    ),

  /**
   * Updates an existing event
   * @param id - The ID of the event to update
   * @param event - The partial event data to update
   * @returns TaskEither with updated event or error
   * @throws APIError with DB_ERROR code if update fails
   */
  update: (id: EventId, event: PrismaEventUpdate): TE.TaskEither<APIError, PrismaEvent> =>
    TE.tryCatch(
      () =>
        prisma.event.update({
          where: { id: Number(id) },
          data: event as unknown as Prisma.EventUpdateInput,
        }),
      (error) => createDatabaseError({ message: 'Failed to update event', details: { error } }),
    ),

  /**
   * Creates a batch of new events
   * @param events - The events data to create
   * @returns TaskEither with created events or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  saveBatch: (events: PrismaEventCreate[]): TE.TaskEither<APIError, PrismaEvent[]> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(
          events.map((event) => {
            const data = {
              ...event,
              highestScore: event.highestScore ?? undefined,
              highestScoringEntry: event.highestScoringEntry ?? undefined,
              mostSelected: event.mostSelected ?? undefined,
              mostTransferredIn: event.mostTransferredIn ?? undefined,
              mostCaptained: event.mostCaptained ?? undefined,
              mostViceCaptained: event.mostViceCaptained ?? undefined,
              topElement: event.topElement ?? undefined,
              createdAt: event.createdAt ?? new Date(),
            };
            return prisma.event.upsert({
              where: { id: Number(event.id) },
              update: data,
              create: data,
            });
          }),
        ),
      (error) => createDatabaseError({ message: 'Failed to save events', details: { error } }),
    ),

  /**
   * Finds events by their IDs
   * @param ids - The event IDs to find
   * @returns TaskEither with found events or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByIds: (ids: EventId[]): TE.TaskEither<APIError, PrismaEvent[]> =>
    TE.tryCatch(
      () =>
        prisma.event.findMany({
          where: { id: { in: ids.map(Number) } },
        }),
      (error) => createDatabaseError({ message: 'Failed to find events', details: { error } }),
    ),

  /**
   * Finds the current event
   * @returns TaskEither with current event or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findCurrent: (): TE.TaskEither<APIError, PrismaEvent | null> =>
    TE.tryCatch(
      () =>
        prisma.event.findFirst({
          where: { isCurrent: true },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to find current event', details: { error } }),
    ),

  /**
   * Finds the next event
   * @returns TaskEither with next event or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findNext: (): TE.TaskEither<APIError, PrismaEvent | null> =>
    TE.tryCatch(
      () =>
        prisma.event.findFirst({
          where: { isNext: true },
        }),
      (error) => createDatabaseError({ message: 'Failed to find next event', details: { error } }),
    ),

  /**
   * Deletes all events except system defaults
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.event.deleteMany({
            where: { id: { gt: 0 } }, // Preserve system defaults if any
          });
        }),
      (error) => createDatabaseError({ message: 'Failed to delete events', details: { error } }),
    ),

  /**
   * Deletes events by their IDs
   * @param ids - The event IDs to delete
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteByIds: (ids: EventId[]): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.event.deleteMany({
            where: { id: { in: ids.map(Number) } },
          });
        }),
      (error) => createDatabaseError({ message: 'Failed to delete events', details: { error } }),
    ),
};
