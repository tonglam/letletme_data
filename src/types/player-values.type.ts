import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { APIError } from '../infrastructure/http/common/errors';
import {
  BaseRepository,
  Branded,
  createBrandedType,
  ElementType,
  getElementTypeById,
  isApiResponse,
  ValueChangeType,
} from './base.type';
import { ElementResponse } from './elements.type';

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
      (v): v is string => typeof v === 'string' && v.length > 0,
      () => 'Invalid player value ID: must be a non-empty string',
    ),
    E.map((v) => v as PlayerValueId),
  );

// ============ Types ============
/**
 * Domain types (camelCase)
 */
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

// ============ Repository Interface ============
export interface PlayerValueRepository
  extends BaseRepository<PrismaPlayerValue, PrismaPlayerValueCreate, PlayerValueId> {
  findByChangeDate: (changeDate: string) => TE.TaskEither<APIError, PrismaPlayerValue[]>;
  findByElementType: (elementType: number) => TE.TaskEither<APIError, PrismaPlayerValue[]>;
  findByChangeType: (changeType: ValueChangeType) => TE.TaskEither<APIError, PrismaPlayerValue[]>;
  findByEventId: (eventId: number) => TE.TaskEither<APIError, PrismaPlayerValue[]>;
}

// ============ Persistence Types ============
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

// ============ Converters ============
export const toDomainPlayerValue = (data: ElementResponse | PrismaPlayerValue): PlayerValue => {
  const isElementResponse = (d: ElementResponse | PrismaPlayerValue): d is ElementResponse =>
    isApiResponse(d, 'element_type');

  return {
    id: data.id as PlayerValueId,
    elementId: isElementResponse(data) ? data.id : data.elementId,
    elementType: isElementResponse(data)
      ? getElementTypeById(data.element_type) ?? ElementType.GKP
      : getElementTypeById(data.elementType) ?? ElementType.GKP,
    eventId: isElementResponse(data) ? data.event_points : data.eventId,
    value: isElementResponse(data) ? data.now_cost : data.value,
    changeDate: isElementResponse(data) ? new Date().toISOString().slice(0, 10) : data.changeDate,
    changeType: isElementResponse(data) ? ValueChangeType.Start : data.changeType,
    lastValue: isElementResponse(data) ? data.cost_change_start : data.lastValue,
  };
};

export const toPrismaPlayerValue = (value: PlayerValue): PrismaPlayerValueCreate => ({
  elementId: value.elementId,
  elementType: Number(value.elementType),
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
