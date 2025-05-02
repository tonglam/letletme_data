import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from 'types/base.type';

export type PhaseId = Branded<number, 'PhaseId'>;

export const createPhaseId = createBrandedType<number, 'PhaseId'>(
  'PhaseId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

export const validatePhaseId = (value: unknown): E.Either<string, PhaseId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid phase ID: must be a positive integer',
    ),
    E.map((v) => v as PhaseId),
  );

export type Phase = {
  readonly id: PhaseId;
  readonly name: string;
  readonly startEvent: number;
  readonly stopEvent: number;
  readonly highestScore: number | null;
};

export type Phases = readonly Phase[];
