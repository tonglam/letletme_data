import { PrismaClient } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { DomainErrorCode, createDomainError } from '../../../types/error.type';
import { PlayerId } from '../../../types/player/base.type';
import { PlayerCommand, PlayerCreate, PlayerUpdate } from '../../../types/player/command.type';
import { PlayerEventBus } from '../../../types/player/event.type';
import { toPrismaPlayerCreate, toPrismaPlayerUpdate } from './converter';

/**
 * Creates a command repository for player write operations
 */
export const createPlayerCommandRepository = (
  prisma: PrismaClient,
  eventBus: PlayerEventBus,
): PlayerCommand => ({
  createPlayer: (data: PlayerCreate) =>
    pipe(
      TE.tryCatch(
        async () => {
          // Check if player exists
          const existingPlayer = await prisma.player.findUnique({
            where: { element: Number(data.id) },
          });

          if (existingPlayer) {
            // If player exists, update it
            return prisma.player.update({
              where: { element: Number(data.id) },
              data: toPrismaPlayerCreate(data),
            });
          }

          // If player doesn't exist, create it
          return prisma.player.create({
            data: toPrismaPlayerCreate(data),
          });
        },
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to create player',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain(() => eventBus.publish({ type: 'PLAYER_CREATED', payload: data })),
    ),

  updatePlayer: (data: PlayerUpdate) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.update({
            where: { element: Number(data.id) },
            data: toPrismaPlayerUpdate(data),
          }),
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to update player',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain(() => eventBus.publish({ type: 'PLAYER_UPDATED', payload: data })),
    ),

  updatePrice: (id: PlayerId, price: number) =>
    pipe(
      TE.tryCatch(
        () =>
          prisma.player.update({
            where: { element: Number(id) },
            data: { price },
          }),
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to update player price',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain(() => eventBus.publish({ type: 'PLAYER_PRICE_CHANGED', payload: { id, price } })),
    ),

  deletePlayer: (id: PlayerId) =>
    pipe(
      TE.tryCatch(
        () => prisma.player.delete({ where: { element: Number(id) } }),
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to delete player',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain(() => eventBus.publish({ type: 'PLAYER_DELETED', payload: { id } })),
    ),

  saveBatch: (players: readonly PlayerCreate[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          // Get all existing players
          const existingPlayers = await prisma.player.findMany({
            where: {
              element: {
                in: [...players].map((p) => Number(p.id)),
              },
            },
          });

          const existingIds = new Set(existingPlayers.map((p) => p.element));

          // Split players into new and existing
          const newPlayers = [...players].filter((p) => !existingIds.has(Number(p.id)));
          const updatePlayers = [...players].filter((p) => existingIds.has(Number(p.id)));

          // Create new players
          const createPromise =
            newPlayers.length > 0
              ? prisma.player.createMany({
                  data: newPlayers.map(toPrismaPlayerCreate),
                })
              : Promise.resolve();

          // Update existing players
          const updatePromises = updatePlayers.map((player) =>
            prisma.player.update({
              where: { element: Number(player.id) },
              data: toPrismaPlayerCreate(player),
            }),
          );

          // Execute all operations
          await Promise.all([createPromise, ...updatePromises]);

          // Return all players
          return prisma.player.findMany({
            where: {
              element: {
                in: [...players].map((p) => Number(p.id)),
              },
            },
          });
        },
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to create players',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain((createdPlayers) =>
        pipe(
          eventBus.publish({ type: 'PLAYERS_CREATED', payload: players }),
          TE.map(() => createdPlayers),
        ),
      ),
      TE.map(() => undefined),
    ),

  updatePrices: (updates: readonly { id: PlayerId; price: number }[]) =>
    pipe(
      TE.tryCatch(
        async () => {
          await prisma.$transaction(
            updates.map((update) =>
              prisma.player.update({
                where: { element: Number(update.id) },
                data: { price: update.price },
              }),
            ),
          );
        },
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to update player prices',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain(() => eventBus.publish({ type: 'PLAYERS_PRICES_UPDATED', payload: updates })),
    ),

  deleteAll: () =>
    pipe(
      TE.tryCatch(
        () => prisma.player.deleteMany(),
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to delete all players',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain(() => eventBus.publish({ type: 'PLAYERS_DELETED', payload: void 0 })),
    ),
});
