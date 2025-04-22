import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';

import { Branded, createBrandedType, ElementTypeId, ElementTypeName } from '../base.type';
import { TeamId } from './team.type';

export type PlayerStatId = Branded<number, 'PlayerStatId'>;

export const PlayerStatId = createBrandedType<number, 'PlayerStatId'>(
  'PlayerStatId',
  (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0,
);

export const validatePlayerStatIdInput = (value: unknown): E.Either<string, PlayerStatId> => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return E.left('Invalid player stat ID: input must be a non-empty string');
  }
  const numericId = parseInt(value, 10);
  if (isNaN(numericId) || !Number.isInteger(numericId) || numericId <= 0) {
    return E.left('Invalid player stat ID: input must be a string representing a positive integer');
  }
  return E.right(numericId as PlayerStatId);
};

export interface PlayerStat {
  readonly id: PlayerStatId;
  readonly event: number;
  readonly element: number;
  readonly elementType: ElementTypeId;
  readonly elementTypeName: ElementTypeName;
  readonly team: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly value: number;
  readonly totalPoints: number | null;
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
  readonly mngWin: number | null;
  readonly mngDraw: number | null;
  readonly mngLoss: number | null;
  readonly mngUnderdogWin: number | null;
  readonly mngUnderdogDraw: number | null;
  readonly mngCleanSheets: number | null;
  readonly mngGoalsScored: number | null;
}

export type PlayerStats = readonly PlayerStat[];

export type SourcePlayerStat = Omit<
  PlayerStat,
  'id' | 'elementTypeName' | 'team' | 'teamName' | 'teamShortName' | 'value'
> & {
  readonly id?: PlayerStatId;
};
export type SourcePlayerStats = readonly SourcePlayerStat[];
