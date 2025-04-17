import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType, ElementType, ValueChangeType } from '../base.type';

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
export type MappedPlayerValue = Omit<PlayerValue, 'id' | 'lastValue' | 'changeType'>;
