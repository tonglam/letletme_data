import * as TE from 'fp-ts/TaskEither';
import { prisma } from '../../infrastructure/db/prisma';
import { convertToDecimal } from '../../infrastructure/db/utils';
import { APIError, createDatabaseError } from '../../infrastructure/http/common/errors';
import {
  PlayerStatRepository,
  PrismaPlayerStat,
  PrismaPlayerStatCreate,
} from '../../types/player-stats.type';

/**
 * Player stats repository implementation
 * Provides data access operations for PlayerStat entity
 */
export const playerStatRepository: PlayerStatRepository = {
  prisma,
  /**
   * Creates a new player stat
   * @param stat - The player stat data to create
   * @returns TaskEither with created player stat or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  save: (stat: PrismaPlayerStatCreate): TE.TaskEither<APIError, PrismaPlayerStat> =>
    TE.tryCatch(
      () =>
        prisma.playerStat.create({
          data: convertToDecimal(stat),
        }),
      (error) => createDatabaseError({ message: 'Failed to save player stat', details: { error } }),
    ),

  /**
   * Finds a player stat by its ID
   * @param id - The player stat ID to find
   * @returns TaskEither with found player stat or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findById: (id: string): TE.TaskEither<APIError, PrismaPlayerStat | null> =>
    TE.tryCatch(
      () =>
        prisma.playerStat.findUnique({
          where: { id },
        }),
      (error) => createDatabaseError({ message: 'Failed to find player stat', details: { error } }),
    ),

  /**
   * Retrieves all player stats ordered by event ID
   * @returns TaskEither with array of player stats or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findAll: (): TE.TaskEither<APIError, PrismaPlayerStat[]> =>
    TE.tryCatch(
      () =>
        prisma.playerStat.findMany({
          orderBy: { eventId: 'desc' },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to find player stats', details: { error } }),
    ),

  /**
   * Updates an existing player stat
   * @param id - The ID of the player stat to update
   * @param stat - The partial player stat data to update
   * @returns TaskEither with updated player stat or error
   * @throws APIError with DB_ERROR code if update fails
   */
  update: (
    id: string,
    stat: Partial<PrismaPlayerStatCreate>,
  ): TE.TaskEither<APIError, PrismaPlayerStat> =>
    TE.tryCatch(
      () =>
        prisma.playerStat.update({
          where: { id },
          data: convertToDecimal(stat, true),
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to update player stat', details: { error } }),
    ),

  /**
   * Creates a batch of new player stats
   * @param stats - The player stats data to create
   * @returns TaskEither with created player stats or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  saveBatch: (stats: PrismaPlayerStatCreate[]): TE.TaskEither<APIError, PrismaPlayerStat[]> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(
          stats.map((stat) =>
            prisma.playerStat.create({
              data: convertToDecimal(stat),
            }),
          ),
        ),
      (error) =>
        createDatabaseError({ message: 'Failed to save player stats', details: { error } }),
    ),

  /**
   * Finds player stats by their IDs
   * @param ids - The player stat IDs to find
   * @returns TaskEither with found player stats or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByIds: (ids: string[]): TE.TaskEither<APIError, PrismaPlayerStat[]> =>
    TE.tryCatch(
      () =>
        prisma.playerStat.findMany({
          where: { id: { in: ids } },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to find player stats', details: { error } }),
    ),

  /**
   * Deletes all player stats
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () => prisma.playerStat.deleteMany().then(() => undefined),
      (error) =>
        createDatabaseError({ message: 'Failed to delete player stats', details: { error } }),
    ),

  /**
   * Deletes player stats by their IDs
   * @param ids - The player stat IDs to delete
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteByIds: (ids: string[]): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.playerStat
          .deleteMany({
            where: { id: { in: ids } },
          })
          .then(() => undefined),
      (error) =>
        createDatabaseError({ message: 'Failed to delete player stats', details: { error } }),
    ),

  /**
   * Finds player stats by element ID
   * @param elementId - The element ID to find stats for
   * @returns TaskEither with found player stats or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByElementId: (elementId: number): TE.TaskEither<APIError, PrismaPlayerStat[]> =>
    TE.tryCatch(
      () =>
        prisma.playerStat.findMany({
          where: { elementId },
          orderBy: { eventId: 'desc' },
        }),
      (error) =>
        createDatabaseError({
          message: 'Failed to find player stats by element ID',
          details: { error },
        }),
    ),

  /**
   * Finds player stats by event ID
   * @param eventId - The event ID to find stats for
   * @returns TaskEither with found player stats or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByEventId: (eventId: number): TE.TaskEither<APIError, PrismaPlayerStat[]> =>
    TE.tryCatch(
      () =>
        prisma.playerStat.findMany({
          where: { eventId },
          orderBy: { elementId: 'asc' },
        }),
      (error) =>
        createDatabaseError({
          message: 'Failed to find player stats by event ID',
          details: { error },
        }),
    ),

  /**
   * Finds player stats by element ID and event ID
   * @param elementId - The element ID to find stats for
   * @param eventId - The event ID to find stats for
   * @returns TaskEither with found player stat or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findByElementAndEvent: (
    elementId: number,
    eventId: number,
  ): TE.TaskEither<APIError, PrismaPlayerStat | null> =>
    TE.tryCatch(
      () =>
        prisma.playerStat.findFirst({
          where: { elementId, eventId },
        }),
      (error) =>
        createDatabaseError({
          message: 'Failed to find player stat by element and event ID',
          details: { error },
        }),
    ),

  /**
   * Finds player stats by team ID
   * @param teamId - The team ID to find stats for
   * @returns TaskEither with found player stats or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByTeamId: (teamId: number): TE.TaskEither<APIError, PrismaPlayerStat[]> =>
    TE.tryCatch(
      () =>
        prisma.playerStat.findMany({
          where: { teamId },
          orderBy: [{ eventId: 'desc' }, { elementId: 'asc' }],
        }),
      (error) =>
        createDatabaseError({
          message: 'Failed to find player stats by team ID',
          details: { error },
        }),
    ),
};
