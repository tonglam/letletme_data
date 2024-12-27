import { ValueChangeType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { prisma } from '../../infrastructure/db/prisma';
import { APIError, createDatabaseError } from '../../infrastructure/http/common/errors';
import {
  PlayerValueRepository,
  PrismaPlayerValue,
  PrismaPlayerValueCreate,
} from '../../types/player-values.type';

/**
 * Player value repository implementation
 * Provides data access operations for PlayerValue entity
 */
export const playerValueRepository: PlayerValueRepository = {
  prisma,
  /**
   * Creates a new player value
   * @param value - The player value data to create
   * @returns TaskEither with created player value or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  save: (value: PrismaPlayerValueCreate): TE.TaskEither<APIError, PrismaPlayerValue> =>
    TE.tryCatch(
      () =>
        prisma.playerValue.create({
          data: value,
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to save player value', details: { error } }),
    ),

  /**
   * Finds a player value by its ID
   * @param id - The player value ID to find
   * @returns TaskEither with found player value or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findById: (id: string): TE.TaskEither<APIError, PrismaPlayerValue | null> =>
    TE.tryCatch(
      () =>
        prisma.playerValue.findUnique({
          where: { id },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to find player value', details: { error } }),
    ),

  /**
   * Retrieves all player values ordered by change date
   * @returns TaskEither with array of player values or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findAll: (): TE.TaskEither<APIError, PrismaPlayerValue[]> =>
    TE.tryCatch(
      () =>
        prisma.playerValue.findMany({
          orderBy: { changeDate: 'desc' },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to find player values', details: { error } }),
    ),

  /**
   * Updates an existing player value
   * @param id - The ID of the player value to update
   * @param value - The partial player value data to update
   * @returns TaskEither with updated player value or error
   * @throws APIError with DB_ERROR code if update fails
   */
  update: (
    id: string,
    value: Partial<PrismaPlayerValueCreate>,
  ): TE.TaskEither<APIError, PrismaPlayerValue> =>
    TE.tryCatch(
      () =>
        prisma.playerValue.update({
          where: { id },
          data: value,
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to update player value', details: { error } }),
    ),

  /**
   * Creates a batch of new player values
   * @param values - The player values data to create
   * @returns TaskEither with created player values or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  saveBatch: (values: PrismaPlayerValueCreate[]): TE.TaskEither<APIError, PrismaPlayerValue[]> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(
          values.map((value) =>
            prisma.playerValue.create({
              data: value,
            }),
          ),
        ),
      (error) =>
        createDatabaseError({ message: 'Failed to save player values', details: { error } }),
    ),

  /**
   * Finds player values by their IDs
   * @param ids - The player value IDs to find
   * @returns TaskEither with found player values or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByIds: (ids: string[]): TE.TaskEither<APIError, PrismaPlayerValue[]> =>
    TE.tryCatch(
      () =>
        prisma.playerValue.findMany({
          where: { id: { in: ids } },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to find player values', details: { error } }),
    ),

  /**
   * Deletes all player values
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () => prisma.playerValue.deleteMany().then(() => undefined),
      (error) =>
        createDatabaseError({ message: 'Failed to delete player values', details: { error } }),
    ),

  /**
   * Deletes player values by their IDs
   * @param ids - The player value IDs to delete
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteByIds: (ids: string[]): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.playerValue
          .deleteMany({
            where: { id: { in: ids } },
          })
          .then(() => undefined),
      (error) =>
        createDatabaseError({ message: 'Failed to delete player values', details: { error } }),
    ),

  /**
   * Finds player values by change date
   * @param changeDate - The specific change date to search for
   * @returns TaskEither with found player values or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByChangeDate: (changeDate: string): TE.TaskEither<APIError, PrismaPlayerValue[]> =>
    TE.tryCatch(
      () =>
        prisma.playerValue.findMany({
          where: { changeDate },
        }),
      (error) =>
        createDatabaseError({
          message: 'Failed to find player values by change date',
          details: { error },
        }),
    ),

  /**
   * Finds player values by element type
   * @param elementType - The element type number to search for (1: GKP, 2: DEF, 3: MID, 4: FWD)
   * @returns TaskEither with found player values or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByElementType: (elementType: number): TE.TaskEither<APIError, PrismaPlayerValue[]> =>
    TE.tryCatch(
      () =>
        prisma.playerValue.findMany({
          where: { elementType },
        }),
      (error) =>
        createDatabaseError({
          message: 'Failed to find player values by element type',
          details: { error },
        }),
    ),

  /**
   * Finds player values by change type
   * @param changeType - The value change type to search for
   * @returns TaskEither with found player values or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByChangeType: (changeType: ValueChangeType): TE.TaskEither<APIError, PrismaPlayerValue[]> =>
    TE.tryCatch(
      () =>
        prisma.playerValue.findMany({
          where: { changeType },
        }),
      (error) =>
        createDatabaseError({
          message: 'Failed to find player values by change type',
          details: { error },
        }),
    ),

  /**
   * Finds player values by event ID
   * @param eventId - The event ID to search for
   * @returns TaskEither with found player values or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByEventId: (eventId: number): TE.TaskEither<APIError, PrismaPlayerValue[]> =>
    TE.tryCatch(
      () =>
        prisma.playerValue.findMany({
          where: { eventId },
        }),
      (error) =>
        createDatabaseError({
          message: 'Failed to find player values by event ID',
          details: { error },
        }),
    ),
};
