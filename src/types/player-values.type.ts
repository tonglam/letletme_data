import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../infrastructure/http/common/errors';
import { BaseRepository, ElementType, ValueChangeType } from './base.type';

// ============ Types ============
/**
 * Domain types (camelCase)
 */
export interface PlayerValue {
  readonly id: string;
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
export type PlayerValueRepository = BaseRepository<
  PrismaPlayerValue,
  PrismaPlayerValueCreate,
  string
>;

// ============ Persistence Types ============
export interface PrismaPlayerValue {
  readonly id: string;
  readonly elementId: number;
  readonly elementType: ElementType;
  readonly eventId: number;
  readonly value: number;
  readonly changeDate: string;
  readonly changeType: ValueChangeType;
  readonly lastValue: number;
  readonly createdAt: Date;
}

export type PrismaPlayerValueCreate = Omit<PrismaPlayerValue, 'id' | 'createdAt'>;

// ============ Converters ============
export const toDomainPlayerValue = (prisma: PrismaPlayerValue): PlayerValue => ({
  id: prisma.id,
  elementId: prisma.elementId,
  elementType: prisma.elementType,
  eventId: prisma.eventId,
  value: prisma.value,
  changeDate: prisma.changeDate,
  changeType: prisma.changeType,
  lastValue: prisma.lastValue,
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
