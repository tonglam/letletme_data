import { ElementType, Player, Prisma } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { prisma } from '../../infrastructure/db/prisma';
import { APIError, createDatabaseError } from '../../infrastructure/errors';

/**
 * Player repository implementation
 * Provides data access operations for Player entity
 */
export const createPlayerRepository = (prismaClient: typeof prisma) => {
  /**
   * Creates or updates a player
   * @param player - The player data to create or update
   * @returns TaskEither with created/updated player or error
   * @throws APIError with DB_ERROR code if operation fails
   */
  const save = (player: Prisma.PlayerUncheckedCreateInput): TE.TaskEither<APIError, Player> =>
    TE.tryCatch(
      () =>
        prismaClient.player.upsert({
          where: { element: player.element },
          update: {
            elementCode: player.elementCode,
            elementType: player.elementType,
            firstName: player.firstName,
            secondName: player.secondName,
            webName: player.webName,
            teamId: player.teamId,
            price: player.price,
            startPrice: player.startPrice,
          },
          create: {
            element: player.element,
            elementCode: player.elementCode,
            elementType: player.elementType,
            firstName: player.firstName,
            secondName: player.secondName,
            webName: player.webName,
            teamId: player.teamId,
            price: player.price,
            startPrice: player.startPrice,
          },
        }),
      (error) => createDatabaseError({ message: 'Failed to save player', details: { error } }),
    );

  /**
   * Finds a player by ID
   * @param id - The player ID to find
   * @returns TaskEither with found player or null if not found
   * @throws APIError with DB_ERROR code if query fails
   */
  const findById = (id: number): TE.TaskEither<APIError, Player | null> =>
    TE.tryCatch(
      () =>
        prismaClient.player.findUnique({
          where: { element: id },
        }),
      (error) => createDatabaseError({ message: 'Failed to find player', details: { error } }),
    );

  /**
   * Retrieves all players
   * @returns TaskEither with array of players or error
   * @throws APIError with DB_ERROR code if query fails
   */
  const findAll = (): TE.TaskEither<APIError, Player[]> =>
    TE.tryCatch(
      () =>
        prismaClient.player.findMany({
          orderBy: { element: 'asc' },
        }),
      (error) => createDatabaseError({ message: 'Failed to find players', details: { error } }),
    );

  /**
   * Updates an existing player
   * @param id - The ID of the player to update
   * @param player - The partial player data to update
   * @returns TaskEither with updated player or error
   * @throws APIError with DB_ERROR code if update fails
   */
  const update = (
    id: number,
    player: Partial<Prisma.PlayerUncheckedUpdateInput>,
  ): TE.TaskEither<APIError, Player> =>
    TE.tryCatch(
      () =>
        prismaClient.player.update({
          where: { element: id },
          data: player,
        }),
      (error) => createDatabaseError({ message: 'Failed to update player', details: { error } }),
    );

  /**
   * Creates or updates multiple players in a transaction
   * @param players - Array of player data to create or update
   * @returns TaskEither with array of created/updated players or error
   * @throws APIError with DB_ERROR code if operation fails
   */
  const saveBatch = (
    players: Prisma.PlayerUncheckedCreateInput[],
  ): TE.TaskEither<APIError, Player[]> =>
    TE.tryCatch(
      () =>
        prismaClient.$transaction(
          players.map((player) =>
            prismaClient.player.upsert({
              where: { element: player.element },
              update: {
                elementCode: player.elementCode,
                elementType: player.elementType,
                firstName: player.firstName,
                secondName: player.secondName,
                webName: player.webName,
                teamId: player.teamId,
                price: player.price,
                startPrice: player.startPrice,
              },
              create: {
                element: player.element,
                elementCode: player.elementCode,
                elementType: player.elementType,
                firstName: player.firstName,
                secondName: player.secondName,
                webName: player.webName,
                teamId: player.teamId,
                price: player.price,
                startPrice: player.startPrice,
              },
            }),
          ),
        ),
      (error) => createDatabaseError({ message: 'Failed to save players', details: { error } }),
    );

  /**
   * Finds players by team ID
   * @param teamId - The team ID to find players for
   * @returns TaskEither with array of players or error
   * @throws APIError with DB_ERROR code if query fails
   */
  const findByTeamId = (teamId: number): TE.TaskEither<APIError, Player[]> =>
    TE.tryCatch(
      () =>
        prismaClient.player.findMany({
          where: { teamId },
          orderBy: { element: 'asc' },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to find players by team', details: { error } }),
    );

  /**
   * Finds players by position (elementType)
   * @param position - The position to find players for
   * @returns TaskEither with array of players or error
   * @throws APIError with DB_ERROR code if query fails
   */
  const findByPosition = (position: ElementType): TE.TaskEither<APIError, Player[]> =>
    TE.tryCatch(
      () =>
        prismaClient.player.findMany({
          where: { elementType: position },
          orderBy: { price: 'desc' },
        }),
      (error) =>
        createDatabaseError({ message: 'Failed to find players by position', details: { error } }),
    );

  return {
    save,
    findById,
    findAll,
    update,
    saveBatch,
    findByTeamId,
    findByPosition,
  } as const;
};

export type PlayerRepository = ReturnType<typeof createPlayerRepository>;
