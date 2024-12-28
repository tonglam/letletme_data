/**
 * Event Repository Module
 *
 * Provides data access operations for the Event entity using Prisma ORM.
 * Implements repository pattern with functional programming principles.
 *
 * Features:
 * - Type-safe database operations
 * - Functional error handling using TaskEither
 * - Transaction support for batch operations
 * - Automatic JSON serialization for complex fields
 * - Comprehensive error mapping to domain errors
 *
 * All operations are wrapped in TaskEither for consistent error handling
 * and functional composition throughout the application.
 */

import * as TE from 'fp-ts/TaskEither';
import { prisma } from '../../infrastructure/db/prisma';
import { toNullableJson } from '../../infrastructure/db/utils';
import { APIError, createDatabaseError } from '../../infrastructure/http/common/errors';
import {
  EventId,
  EventRepository,
  PrismaEvent,
  PrismaEventCreate,
  PrismaEventUpdate,
} from '../../types/events.type';

/**
 * Event repository implementation.
 * Provides data access operations for Event entity using Prisma ORM.
 * All operations return TaskEither for functional error handling.
 */
export const eventRepository: EventRepository = {
  prisma,

  /**
   * Creates a new event in the database.
   * Handles JSON serialization of complex fields.
   *
   * @param event - The event data to create
   * @returns TaskEither with created event or database error
   * @throws APIError with DB_ERROR code if creation fails
   */
  save: (event: PrismaEventCreate): TE.TaskEither<APIError, PrismaEvent> =>
    TE.tryCatch(
      () =>
        prisma.event.create({
          data: {
            ...event,
            chipPlays: toNullableJson(event.chipPlays),
            topElementInfo: toNullableJson(event.topElementInfo),
          },
        }),
      (error) => createDatabaseError({ message: 'Failed to save event', details: { error } }),
    ),

  /**
   * Finds an event by its unique identifier.
   *
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
   * Retrieves all events from the database.
   * Results are ordered by ID in ascending order.
   *
   * @returns TaskEither with array of events or database error
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
   * Updates an existing event by ID.
   * Handles partial updates and JSON serialization of complex fields.
   *
   * @param id - The ID of the event to update
   * @param event - The partial event data to update
   * @returns TaskEither with updated event or database error
   * @throws APIError with DB_ERROR code if update fails
   */
  update: (id: EventId, event: PrismaEventUpdate): TE.TaskEither<APIError, PrismaEvent> =>
    TE.tryCatch(
      () =>
        prisma.event.update({
          where: { id: Number(id) },
          data: {
            ...event,
            chipPlays: event.chipPlays !== undefined ? toNullableJson(event.chipPlays) : undefined,
            topElementInfo:
              event.topElementInfo !== undefined ? toNullableJson(event.topElementInfo) : undefined,
          },
        }),
      (error) => createDatabaseError({ message: 'Failed to update event', details: { error } }),
    ),

  /**
   * Creates multiple events in a single transaction.
   * Ensures atomic batch creation with rollback on failure.
   *
   * @param events - Array of event data to create
   * @returns TaskEither with created events or database error
   * @throws APIError with DB_ERROR code if transaction fails
   */
  saveBatch: (events: PrismaEventCreate[]): TE.TaskEither<APIError, PrismaEvent[]> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(
          events.map((event) =>
            prisma.event.create({
              data: {
                ...event,
                chipPlays: toNullableJson(event.chipPlays),
                topElementInfo: toNullableJson(event.topElementInfo),
              },
            }),
          ),
        ),
      (error) => createDatabaseError({ message: 'Failed to save events', details: { error } }),
    ),

  /**
   * Finds multiple events by their IDs.
   *
   * @param ids - Array of event IDs to find
   * @returns TaskEither with found events or database error
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
   * Finds the current active event.
   * Returns null if no current event exists.
   *
   * @returns TaskEither with current event or null
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
   * Finds the next scheduled event.
   * Returns null if no next event exists.
   *
   * @returns TaskEither with next event or null
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
   * Deletes all events except system defaults.
   * Uses transaction for atomic operation.
   *
   * @returns TaskEither with void or database error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(async (tx) => {
          await tx.event.deleteMany({
            where: { id: { gt: 0 } },
          });
        }),
      (error) => createDatabaseError({ message: 'Failed to delete events', details: { error } }),
    ),

  /**
   * Deletes multiple events by their IDs.
   * Uses transaction for atomic operation.
   *
   * @param ids - Array of event IDs to delete
   * @returns TaskEither with void or database error
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
