/**
 * Event Repository Module
 *
 * Provides data access operations for the Event entity using Prisma ORM.
 * Implements repository pattern with functional programming principles,
 * ensuring type-safe database operations and consistent error handling.
 *
 * @module EventRepository
 */

import { pipe } from 'fp-ts/function';
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
 *
 * @implements {EventRepository}
 */
export const eventRepository: EventRepository = {
  prisma,

  /**
   * Creates a new event in the database.
   * Handles JSON serialization of complex fields.
   *
   * @param {PrismaEventCreate} event - The event data to create
   * @returns {TaskEither<APIError, PrismaEvent>} Created event or database error
   * @throws {APIError} With DB_ERROR code if creation fails
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
      (error) => createDatabaseError({ message: 'Failed to create event', details: { error } }),
    ),

  /**
   * Creates multiple events in a single transaction.
   * Ensures atomic batch operations.
   *
   * @param {PrismaEventCreate[]} events - Array of events to create
   * @returns {TaskEither<APIError, PrismaEvent[]>} Created events or database error
   * @throws {APIError} With DB_ERROR code if batch creation fails
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
      (error) => createDatabaseError({ message: 'Failed to create events', details: { error } }),
    ),

  /**
   * Retrieves all events from the database.
   * Orders results by event ID ascending.
   *
   * @returns {TaskEither<APIError, PrismaEvent[]>} Array of events or database error
   * @throws {APIError} With DB_ERROR code if query fails
   */
  findAll: (): TE.TaskEither<APIError, PrismaEvent[]> =>
    TE.tryCatch(
      () =>
        prisma.event.findMany({
          orderBy: { id: 'asc' },
        }),
      (error) => createDatabaseError({ message: 'Failed to fetch events', details: { error } }),
    ),

  /**
   * Finds multiple events by their IDs.
   *
   * @param {EventId[]} ids - Array of event IDs to find
   * @returns {TaskEither<APIError, PrismaEvent[]>} Found events or database error
   * @throws {APIError} With DB_ERROR code if query fails
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
   * Finds a single event by its ID.
   *
   * @param {EventId} id - Event identifier
   * @returns {TaskEither<APIError, PrismaEvent | null>} Event if found or null
   * @throws {APIError} With DB_ERROR code if query fails
   */
  findById: (id: EventId): TE.TaskEither<APIError, PrismaEvent | null> =>
    TE.tryCatch(
      () => prisma.event.findUnique({ where: { id: Number(id) } }),
      (error) => createDatabaseError({ message: 'Failed to fetch event', details: { error } }),
    ),

  /**
   * Finds the currently active event.
   * Determined by isCurrent flag.
   *
   * @returns {TaskEither<APIError, PrismaEvent | null>} Current event if exists or null
   * @throws {APIError} With DB_ERROR code if query fails
   */
  findCurrent: (): TE.TaskEither<APIError, PrismaEvent | null> =>
    TE.tryCatch(
      () =>
        prisma.event.findFirst({
          where: { isCurrent: true },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to fetch current event', details: { error } }),
    ),

  /**
   * Finds the next scheduled event.
   * Based on isNext flag.
   *
   * @returns {TaskEither<APIError, PrismaEvent | null>} Next event if exists or null
   * @throws {APIError} With DB_ERROR code if query fails
   */
  findNext: (): TE.TaskEither<APIError, PrismaEvent | null> =>
    TE.tryCatch(
      () =>
        prisma.event.findFirst({
          where: { isNext: true },
        }),
      (error) => createDatabaseError({ message: 'Failed to fetch next event', details: { error } }),
    ),

  /**
   * Updates an existing event.
   * Handles JSON serialization of complex fields.
   *
   * @param {EventId} id - Event identifier
   * @param {PrismaEventUpdate} event - Updated event data
   * @returns {TaskEither<APIError, PrismaEvent>} Updated event or database error
   * @throws {APIError} With DB_ERROR code if update fails
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
   * Deletes all events from the database.
   * Use with caution as this is a destructive operation.
   *
   * @returns {TaskEither<APIError, void>} Success or database error
   * @throws {APIError} With DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () => prisma.event.deleteMany(),
        (error) => createDatabaseError({ message: 'Failed to delete events', details: { error } }),
      ),
      TE.map(() => undefined),
    ),

  /**
   * Deletes multiple events by their IDs.
   * Uses transaction for atomic operation.
   *
   * @param {EventId[]} ids - Array of event IDs to delete
   * @returns {TaskEither<APIError, void>} Success or database error
   * @throws {APIError} With DB_ERROR code if deletion fails
   */
  deleteByIds: (ids: EventId[]): TE.TaskEither<APIError, void> =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.event.deleteMany({
            where: { id: { in: ids.map(Number) } },
          }),
        (error) => createDatabaseError({ message: 'Failed to delete events', details: { error } }),
      ),
      TE.map(() => undefined),
    ),
};
