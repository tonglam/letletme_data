import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, ElementType, createBrandedType } from '../base.type';

/**
 * Branded type for Player ID ensuring type safety
 */
export type PlayerId = Branded<number, 'PlayerId'>;

export const PlayerId = createBrandedType<number, 'PlayerId'>(
  'PlayerId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

export const validatePlayerId = (value: unknown): E.Either<string, PlayerId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid player ID: must be a positive integer',
    ),
    E.map((v) => v as PlayerId),
  );

/**
 * Prisma Player model type
 */
export type PrismaPlayer = {
  element: number;
  elementCode: number;
  price: number;
  startPrice: number;
  elementType: number;
  firstName: string | null;
  secondName: string | null;
  webName: string;
  teamId: number;
  createdAt: Date;
};

/**
 * Domain Player type
 */
export type Player = {
  id: PlayerId;
  elementCode: number;
  price: number;
  startPrice: number;
  elementType: ElementType;
  firstName: string;
  secondName: string;
  webName: string;
  teamId: number;
};

/**
 * Convert Prisma Player to Domain Player
 */
export const toDomainPlayer = (player: PrismaPlayer): Player => ({
  id: player.element as PlayerId,
  elementCode: player.elementCode,
  price: player.price,
  startPrice: player.startPrice,
  elementType: player.elementType as ElementType,
  firstName: player.firstName ?? '',
  secondName: player.secondName ?? '',
  webName: player.webName,
  teamId: player.teamId,
});
