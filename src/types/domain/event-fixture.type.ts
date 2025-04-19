import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from '../base.type';

export type EventFixtureId = Branded<number, 'EventFixtureId'>;

export const createEventFixtureId = createBrandedType<number, 'EventFixtureId'>(
  'EventFixtureId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEventFixtureId = (value: unknown): E.Either<string, EventFixtureId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid event fixture ID: must be a positive integer',
    ),
    E.map((v) => v as EventFixtureId),
  );

export type EventFixture = {
  readonly id: EventFixtureId;
  readonly code: number;
  readonly event: number;
  readonly kickoffTime: Date | null;
  readonly started: boolean;
  readonly finished: boolean;
  readonly minutes: number;
  readonly teamH: number | null;
  readonly teamHDifficulty: number;
  readonly teamHScore: number;
  readonly teamA: number | null;
  readonly teamADifficulty: number;
  readonly teamAScore: number;
};

export type EventFixtures = readonly EventFixture[];
