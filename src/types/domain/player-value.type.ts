import * as E from 'fp-ts/Either';

import { Branded, createBrandedType, ElementType, ValueChangeType } from '../base.type';

export type PlayerValueId = Branded<number, 'PlayerValueId'>;

export const PlayerValueId = createBrandedType<number, 'PlayerValueId'>(
  'PlayerValueId',
  (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0,
);

export const validatePlayerValueIdInput = (value: unknown): E.Either<string, PlayerValueId> => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return E.left('Invalid player value ID: input must be a non-empty string');
  }
  const numericId = parseInt(value, 10);
  if (isNaN(numericId) || !Number.isInteger(numericId) || numericId <= 0) {
    return E.left(
      'Invalid player value ID: input must be a string representing a positive integer',
    );
  }
  return E.right(numericId as PlayerValueId);
};

export interface PlayerValue {
  readonly id: PlayerValueId;
  readonly element: number;
  readonly elementType: ElementType;
  readonly event: number;
  readonly value: number;
  readonly changeDate: string;
  readonly changeType: ValueChangeType;
  readonly lastValue: number;
}

export type PlayerValues = readonly PlayerValue[];
export type MappedPlayerValue = Omit<PlayerValue, 'id' | 'lastValue' | 'changeType'>;
