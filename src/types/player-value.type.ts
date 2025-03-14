import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  BaseRepository,
  Branded,
  createBrandedType,
  ElementType,
  ElementTypeConfig,
  getElementTypeById,
  isApiResponse,
  ValueChangeType,
} from './base.type';
import { ElementResponse } from './element.type';
import { APIError, DBError } from './error.type';

// ============ Branded Types ============
export type PlayerValueId = Branded<string, 'PlayerValueId'>;

export const PlayerValueId = createBrandedType<string, 'PlayerValueId'>(
  'PlayerValueId',
  (value: unknown): value is string => typeof value === 'string' && value.length > 0,
);

export const validatePlayerValueId = (value: unknown): E.Either<string, PlayerValueId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is string =>
        typeof v === 'string' && v.trim().length > 0 && /^\d+_\d{4}-\d{2}-\d{2}$/.test(v),
      () => 'Invalid player value ID: must be a non-empty string in format {number}_{YYYY-MM-DD}',
    ),
    E.map((v) => v as PlayerValueId),
  );

// ============ Types ============
// Domain types representing player value data in our system
export interface PlayerValue {
  readonly id: PlayerValueId;
  readonly elementId: number;
  readonly elementType: ElementType;
  readonly eventId: number;
  readonly value: number;
  readonly changeDate: string;
  readonly changeType: ValueChangeType;
  readonly lastValue: number;
}

export type PlayerValues = readonly PlayerValue[];

// Repository interface for player value data access
export interface PlayerValueRepository
  extends BaseRepository<PrismaPlayerValue, PrismaPlayerValueCreate, PlayerValueId> {
  findByChangeDate: (changeDate: string) => TE.TaskEither<DBError, PrismaPlayerValue[]>;
  findByElementId: (elementId: number) => TE.TaskEither<DBError, PrismaPlayerValue[]>;
  findByElementType: (elementType: number) => TE.TaskEither<DBError, PrismaPlayerValue[]>;
  findByChangeType: (changeType: ValueChangeType) => TE.TaskEither<DBError, PrismaPlayerValue[]>;
  findByEventId: (eventId: number) => TE.TaskEither<DBError, PrismaPlayerValue[]>;
  findLatestByElements: () => TE.TaskEither<DBError, PrismaPlayerValue[]>;
}

// Persistence types for database operations
export interface PrismaPlayerValue {
  readonly id: string;
  readonly elementId: number;
  readonly elementType: number;
  readonly eventId: number;
  readonly value: number;
  readonly changeDate: string;
  readonly changeType: ValueChangeType;
  readonly lastValue: number;
  readonly createdAt: Date;
}

export type PrismaPlayerValueCreate = Omit<PrismaPlayerValue, 'id' | 'createdAt'>;
export type PrismaPlayerValueUpdate = Partial<Omit<PrismaPlayerValue, 'id' | 'createdAt'>>;

// Type transformers for converting between API and domain models
export const toDomainPlayerValue = (data: ElementResponse | PrismaPlayerValue): PlayerValue => {
  const isElementResponse = (d: ElementResponse | PrismaPlayerValue): d is ElementResponse =>
    isApiResponse(d, 'element_type');

  const today = new Date().toISOString().slice(0, 10);

  return {
    id: isElementResponse(data)
      ? (`${data.id}_${today}` as PlayerValueId)
      : (data.id as PlayerValueId),
    elementId: isElementResponse(data) ? data.id : data.elementId,
    elementType: isElementResponse(data)
      ? getElementTypeById(data.element_type) ?? ElementType.GKP
      : getElementTypeById(data.elementType) ?? ElementType.GKP,
    eventId: isElementResponse(data) ? data.event_points : data.eventId,
    value: isElementResponse(data) ? data.now_cost : data.value,
    changeDate: isElementResponse(data) ? today : data.changeDate,
    changeType: isElementResponse(data) ? ValueChangeType.Start : data.changeType,
    lastValue: isElementResponse(data) ? data.cost_change_start : data.lastValue,
  };
};

export const toPrismaPlayerValue = (value: PlayerValue): PrismaPlayerValueCreate => ({
  elementId: value.elementId,
  elementType: ElementTypeConfig[value.elementType].id,
  eventId: value.eventId,
  value: value.value,
  changeDate: value.changeDate,
  changeType: value.changeType,
  lastValue: value.lastValue,
});

export const convertPrismaPlayerValues = (
  playerValues: readonly PrismaPlayerValue[],
): TE.TaskEither<APIError, PlayerValues> =>
  pipe(
    playerValues,
    TE.right,
    TE.map((values) => values.map(toDomainPlayerValue)),
  );

export const convertPrismaPlayerValue = (
  playerValue: PrismaPlayerValue | null,
): TE.TaskEither<APIError, PlayerValue | null> =>
  TE.right(playerValue ? toDomainPlayerValue(playerValue) : null);
