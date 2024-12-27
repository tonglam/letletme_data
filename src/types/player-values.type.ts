import { ValueChangeType } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../infrastructure/http/common/errors';
import { BaseRepository, ElementType } from './base.type';

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
export interface PlayerValueRepository
  extends BaseRepository<PrismaPlayerValue, PrismaPlayerValueCreate, string> {
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

// ============ Converters ============
export const toDomainPlayerValue = (prisma: PrismaPlayerValue): PlayerValue => ({
  id: prisma.id,
  elementId: prisma.elementId,
  elementType: prisma.elementType as ElementType,
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
