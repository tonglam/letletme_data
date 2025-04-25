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
  readonly eventId: number;
  readonly kickoffTime: Date | null;
  readonly started: boolean;
  readonly finished: boolean;
  readonly minutes: number;
  readonly teamH: number | null;
  readonly teamHName: string | null;
  readonly teamHShortName: string | null;
  readonly teamHDifficulty: number | null;
  readonly teamHScore: number | null;
  readonly teamA: number | null;
  readonly teamAName: string | null;
  readonly teamAShortName: string | null;
  readonly teamADifficulty: number | null;
  readonly teamAScore: number | null;
};

export type EventFixtures = readonly EventFixture[];

export type RawEventFixture = Omit<
  EventFixture,
  'teamHName' | 'teamAName' | 'teamHShortName' | 'teamAShortName'
>;
export type RawEventFixtures = readonly RawEventFixture[];
