import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType, ElementType } from '../base.type';

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

export type Player = {
  readonly id: PlayerId;
  readonly elementCode: number;
  readonly price: number;
  readonly startPrice: number;
  readonly elementType: ElementType;
  readonly firstName: string | null;
  readonly secondName: string | null;
  readonly webName: string;
  readonly teamId: number;
  readonly mngWin?: number;
  readonly mngDraw?: number;
  readonly mngLoss?: number;
  readonly mngUnderdogWin?: number;
  readonly mngUnderdogDraw?: number;
  readonly mngCleanSheets?: number;
  readonly mngGoalsScored?: number;
};

export type Players = readonly Player[];
