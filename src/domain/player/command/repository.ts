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
        () => prisma.player.create({ data: toPrismaPlayerCreate(data) }),
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
        () =>
          prisma.player.createMany({
            data: players.map((p) => ({
              element: Number(p.id),
              elementCode: p.elementCode,
              elementType: p.elementType,
              webName: p.webName,
              teamId: p.teamId,
              price: p.price ?? 0,
              startPrice: p.startPrice ?? 0,
              firstName: p.firstName ?? null,
              secondName: p.secondName ?? null,
            })),
          }),
        (error) =>
          createDomainError({
            code: DomainErrorCode.DATABASE_ERROR,
            message: 'Failed to create players',
            cause: error instanceof Error ? error : new Error(String(error)),
          }),
      ),
      TE.chain(() => eventBus.publish({ type: 'PLAYERS_CREATED', payload: players })),
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
