import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { BaseRepository, Branded, createBrandedType, ElementType } from './base.type';
import { ElementResponse } from './elements.type';

// ============ Branded Types ============
export type PlayerId = Branded<number, 'PlayerId'>;

export const PlayerId = createBrandedType<number, 'PlayerId'>(
  'PlayerId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

// ============ Types ============
/**
 * Domain types (camelCase)
 */
export interface Player {
  readonly id: PlayerId;
  readonly elementCode: number;
  readonly price: number;
  readonly startPrice: number;
  readonly elementType: ElementType;
  readonly firstName: string | null;
  readonly secondName: string | null;
  readonly webName: string;
  readonly teamId: number;
}

export type Players = readonly Player[];

// ============ Repository Interface ============
export type PlayerRepository = BaseRepository<PrismaPlayer, PrismaPlayerCreate, PlayerId>;

// ============ Persistence Types ============
export interface PrismaPlayer {
  readonly id: number;
  readonly elementCode: number;
  readonly price: number;
  readonly startPrice: number;
  readonly elementType: ElementType;
  readonly firstName: string | null;
  readonly secondName: string | null;
  readonly webName: string;
  readonly teamId: number;
  readonly createdAt: Date;
}

export type PrismaPlayerCreate = Omit<PrismaPlayer, 'id' | 'createdAt'>;

// ============ Type Transformers ============
export const fromElementResponse = (raw: ElementResponse): E.Either<string, Player> =>
  pipe(
    PlayerId.validate(raw.id),
    E.map((id) => ({
      id,
      elementCode: raw.code,
      price: raw.now_cost,
      startPrice: raw.cost_change_start,
      elementType: raw.element_type as ElementType,
      firstName: raw.first_name,
      secondName: raw.second_name,
      webName: raw.web_name,
      teamId: raw.team,
    })),
  );

// ============ Converters ============
export const toDomainPlayer = (prisma: PrismaPlayer): Player => ({
  id: prisma.id as PlayerId,
  elementCode: prisma.elementCode,
  price: prisma.price,
  startPrice: prisma.startPrice,
  elementType: prisma.elementType,
  firstName: prisma.firstName,
  secondName: prisma.secondName,
  webName: prisma.webName,
  teamId: prisma.teamId,
});

export const convertPrismaPlayers = (
  players: readonly PrismaPlayer[],
): TE.TaskEither<string, Players> =>
  pipe(
    players,
    TE.right,
    TE.map((values) => values.map(toDomainPlayer)),
  );

export const convertPrismaPlayer = (
  player: PrismaPlayer | null,
): TE.TaskEither<string, Player | null> => TE.right(player ? toDomainPlayer(player) : null);
