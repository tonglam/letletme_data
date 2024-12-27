import * as TE from 'fp-ts/TaskEither';
import { prisma } from '../../infrastructure/db/prisma';
import { APIError, createDatabaseError } from '../../infrastructure/http/common/errors';
import {
  PlayerId,
  PlayerRepository,
  PrismaPlayer,
  PrismaPlayerCreate,
} from '../../types/players.type';

/**
 * Player repository implementation
 * Provides data access operations for Player entity
 */
export const playerRepository: PlayerRepository = {
  prisma,
  /**
   * Creates a new player
   * @param player - The player data to create
   * @returns TaskEither with created player or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  save: (player: PrismaPlayerCreate): TE.TaskEither<APIError, PrismaPlayer> =>
    TE.tryCatch(
      () =>
        prisma.player.upsert({
          where: { element: player.element },
          update: player,
          create: player,
        }),
      (error) => createDatabaseError({ message: 'Failed to save player', details: { error } }),
    ),

  /**
   * Finds a player by its ID
   * @param id - The player ID to find
   * @returns TaskEither with found player or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  findById: (id: PlayerId): TE.TaskEither<APIError, PrismaPlayer | null> =>
    TE.tryCatch(
      () =>
        prisma.player.findUnique({
          where: { element: id },
        }),
      (error) => createDatabaseError({ message: 'Failed to find player', details: { error } }),
    ),

  /**
   * Retrieves all players ordered by element type and team ID
   * @returns TaskEither with array of players or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findAll: (): TE.TaskEither<APIError, PrismaPlayer[]> =>
    TE.tryCatch(
      () =>
        prisma.player.findMany({
          orderBy: [{ elementType: 'asc' }, { teamId: 'asc' }],
        }),
      (error) => createDatabaseError({ message: 'Failed to find players', details: { error } }),
    ),

  /**
   * Updates an existing player
   * @param id - The ID of the player to update
   * @param player - The partial player data to update
   * @returns TaskEither with updated player or error
   * @throws APIError with DB_ERROR code if update fails
   */
  update: (
    id: PlayerId,
    player: Partial<PrismaPlayerCreate>,
  ): TE.TaskEither<APIError, PrismaPlayer> =>
    TE.tryCatch(
      () =>
        prisma.player.update({
          where: { element: id },
          data: player,
        }),
      (error) => createDatabaseError({ message: 'Failed to update player', details: { error } }),
    ),

  /**
   * Creates a batch of new players
   * @param players - The players data to create
   * @returns TaskEither with created players or error
   * @throws APIError with DB_ERROR code if creation fails
   */
  saveBatch: (players: PrismaPlayerCreate[]): TE.TaskEither<APIError, PrismaPlayer[]> =>
    TE.tryCatch(
      () =>
        prisma.$transaction(
          players.map((player) =>
            prisma.player.upsert({
              where: { element: player.element },
              update: player,
              create: player,
            }),
          ),
        ),
      (error) => createDatabaseError({ message: 'Failed to save players', details: { error } }),
    ),

  /**
   * Finds players by their IDs
   * @param ids - The player IDs to find
   * @returns TaskEither with found players or error
   * @throws APIError with DB_ERROR code if query fails
   */
  findByIds: (ids: PlayerId[]): TE.TaskEither<APIError, PrismaPlayer[]> =>
    TE.tryCatch(
      () =>
        prisma.player.findMany({
          where: { element: { in: ids } },
        }),
      (error) => createDatabaseError({ message: 'Failed to find players', details: { error } }),
    ),

  /**
   * Deletes all players
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteAll: (): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () => prisma.player.deleteMany().then(() => undefined),
      (error) => createDatabaseError({ message: 'Failed to delete players', details: { error } }),
    ),

  /**
   * Deletes players by their IDs
   * @param ids - The player IDs to delete
   * @returns TaskEither with void or error
   * @throws APIError with DB_ERROR code if deletion fails
   */
  deleteByIds: (ids: PlayerId[]): TE.TaskEither<APIError, void> =>
    TE.tryCatch(
      () =>
        prisma.player
          .deleteMany({
            where: { element: { in: ids } },
          })
          .then(() => undefined),
      (error) => createDatabaseError({ message: 'Failed to delete players', details: { error } }),
    ),
};
