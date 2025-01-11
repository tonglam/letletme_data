import { ElementType } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  BaseRepository,
  Branded,
  createBrandedType,
  getElementTypeById,
  isApiResponse,
} from './base.type';
import { ElementResponse } from './element.type';
import { APIError, DBError } from './error.type';

// ============ Branded Types ============
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

// ============ Types ============
// Domain types representing player data in our system
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

// Repository interface for player data access
export interface PlayerRepository
  extends BaseRepository<PrismaPlayer, PrismaPlayerCreate, PlayerId> {
  updatePrices: (
    updates: readonly { id: PlayerId; price: number }[],
  ) => TE.TaskEither<DBError, void>;
}

// Persistence types for database operations
export interface PrismaPlayer {
  readonly element: number;
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

export type PrismaPlayerCreate = Omit<PrismaPlayer, 'createdAt'>;
export type PrismaPlayerUpdate = Omit<PrismaPlayer, 'createdAt'>;

// Type transformers for converting between API and domain models
export const fromElementResponse = (raw: ElementResponse): E.Either<string, Player> =>
  pipe(
    PlayerId.validate(raw.id),
    E.chain((id) => {
      const elementType = getElementTypeById(raw.element_type);
      return elementType
        ? E.right({
            id,
            elementCode: raw.code,
            price: raw.now_cost,
            startPrice: raw.cost_change_start,
            elementType,
            firstName: raw.first_name,
            secondName: raw.second_name,
            webName: raw.web_name,
            teamId: raw.team,
          })
        : E.left(`Invalid element type: ${raw.element_type}`);
    }),
  );

// ============ Converters ============
export const toDomainPlayer = (data: ElementResponse | PrismaPlayer): Player => {
  const isElementResponse = (d: ElementResponse | PrismaPlayer): d is ElementResponse =>
    isApiResponse(d, 'element_type');

  return {
    id: (isElementResponse(data) ? data.id : data.element) as PlayerId,
    elementCode: isElementResponse(data) ? data.code : data.elementCode,
    price: isElementResponse(data) ? data.now_cost : data.price,
    startPrice: isElementResponse(data) ? data.cost_change_start : data.startPrice,
    elementType: isElementResponse(data)
      ? getElementTypeById(data.element_type) ?? ElementType.GKP
      : data.elementType,
    firstName: isElementResponse(data) ? data.first_name : data.firstName,
    secondName: isElementResponse(data) ? data.second_name : data.secondName,
    webName: isElementResponse(data) ? data.web_name : data.webName,
    teamId: isElementResponse(data) ? data.team : data.teamId,
  };
};

export const toPrismaPlayer = (player: Player): PrismaPlayerCreate => ({
  element: player.id,
  elementCode: player.elementCode,
  price: player.price,
  startPrice: player.startPrice,
  elementType: player.elementType,
  firstName: player.firstName,
  secondName: player.secondName,
  webName: player.webName,
  teamId: player.teamId,
});

export const convertPrismaPlayers = (
  players: readonly PrismaPlayer[],
): TE.TaskEither<APIError, Players> =>
  pipe(
    players,
    TE.right,
    TE.map((values) => values.map(toDomainPlayer)),
  );

export const convertPrismaPlayer = (
  player: PrismaPlayer | null,
): TE.TaskEither<APIError, Player | null> => TE.right(player ? toDomainPlayer(player) : null);
