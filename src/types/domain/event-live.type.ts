import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from '../base.type';

export type EventLiveId = Branded<number, 'EventLiveId'>;

export const createEventLiveId = createBrandedType<number, 'EventLiveId'>(
  'EventLiveId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEventLiveId = (value: unknown): E.Either<string, EventLiveId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid event live ID: must be a positive integer',
    ),
    E.map((v) => v as EventLiveId),
  );
export interface EventLive {
  readonly id: EventLiveId;
  readonly event: number;
  readonly element: number;
  readonly minutes: number | null;
  readonly goalsScored: number | null;
  readonly assists: number | null;
  readonly cleanSheets: number | null;
  readonly goalsConceded: number | null;
  readonly ownGoals: number | null;
  readonly penaltiesSaved: number | null;
  readonly penaltiesMissed: number | null;
  readonly yellowCards: number | null;
  readonly redCards: number | null;
  readonly saves: number | null;
  readonly bonus: number | null;
  readonly bps: number | null;
  readonly starts: boolean | null;
  readonly expectedGoals: Prisma.Decimal | null;
  readonly expectedAssists: Prisma.Decimal | null;
  readonly expectedGoalInvolvements: Prisma.Decimal | null;
  readonly expectedGoalsConceded: Prisma.Decimal | null;
  readonly mngWin: number | null;
  readonly mngDraw: number | null;
  readonly mngLoss: number | null;
  readonly mngUnderdogWin: number | null;
  readonly mngUnderdogDraw: number | null;
  readonly mngCleanSheets: number | null;
  readonly mngGoalsScored: number | null;
  readonly inDreamTeam: boolean | null;
  readonly totalPoints: number;
}

export type MappedEventLive = Omit<EventLive, 'id'>;
export type EventLives = readonly MappedEventLive[];
