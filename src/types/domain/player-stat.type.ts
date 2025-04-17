import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from '../base.type';

export type PlayerStatId = Branded<string, 'PlayerStatId'>;

export const PlayerStatId = createBrandedType<string, 'PlayerStatId'>(
  'PlayerStatId',
  (value: unknown): value is string => typeof value === 'string' && value.length > 0,
);

export const validatePlayerStatId = (value: unknown): E.Either<string, PlayerStatId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is string => typeof v === 'string' && v.length > 0,
      () => 'Invalid player stat ID: must be a non-empty string',
    ),
    E.map((v) => v as PlayerStatId),
  );

export interface PlayerStat {
  readonly id: PlayerStatId;
  readonly eventId: number;
  readonly elementId: number;
  readonly teamId: number;
  readonly form: number | null;
  readonly influence: number | null;
  readonly creativity: number | null;
  readonly threat: number | null;
  readonly ictIndex: number | null;
  readonly expectedGoals: Prisma.Decimal | null;
  readonly expectedAssists: Prisma.Decimal | null;
  readonly expectedGoalInvolvements: Prisma.Decimal | null;
  readonly expectedGoalsConceded: Prisma.Decimal | null;
  readonly minutes: number | null;
  readonly goalsScored: number | null;
  readonly assists: number | null;
  readonly cleanSheets: number | null;
  readonly goalsConceded: number | null;
  readonly ownGoals: number | null;
  readonly penaltiesSaved: number | null;
  readonly yellowCards: number | null;
  readonly redCards: number | null;
  readonly saves: number | null;
  readonly bonus: number | null;
  readonly bps: number | null;
  readonly starts: number | null;
  readonly influenceRank: number | null;
  readonly influenceRankType: number | null;
  readonly creativityRank: number | null;
  readonly creativityRankType: number | null;
  readonly threatRank: number | null;
  readonly threatRankType: number | null;
  readonly ictIndexRank: number | null;
  readonly ictIndexRankType: number | null;
  readonly expectedGoalsPer90: Prisma.Decimal | null;
  readonly savesPer90: Prisma.Decimal | null;
  readonly expectedAssistsPer90: Prisma.Decimal | null;
  readonly expectedGoalInvolvementsPer90: Prisma.Decimal | null;
}

export type PlayerStats = readonly PlayerStat[];
