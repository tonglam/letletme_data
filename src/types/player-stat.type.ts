import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from './base.type';
import { ElementResponse } from './element.type';
import { APIError } from './error.type';

// ============ Branded Types ============
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

// ============ Types ============
// Domain types representing player statistics in our system
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

// Repository interface for player statistics data access
export interface PlayerStatRepository
  extends BaseRepository<PrismaPlayerStat, PrismaPlayerStatCreate, PlayerStatId> {
  findByEventId: (eventId: number) => TE.TaskEither<APIError, PrismaPlayerStat[]>;
  findByElementId: (elementId: number) => TE.TaskEither<APIError, PrismaPlayerStat[]>;
  findByTeamId: (teamId: number) => TE.TaskEither<APIError, PrismaPlayerStat[]>;
}

// Persistence types for database operations
export interface PrismaPlayerStat {
  readonly id: string;
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
  readonly createdAt: Date;
}

export type PrismaPlayerStatCreate = Omit<PrismaPlayerStat, 'id' | 'createdAt'>;
export type PrismaPlayerStatUpdate = Partial<Omit<PrismaPlayerStat, 'id' | 'createdAt'>>;

// Type transformers for converting between API and domain models
export const toDomainPlayerStat = (data: ElementResponse | PrismaPlayerStat): PlayerStat => {
  const isElementResponse = (d: ElementResponse | PrismaPlayerStat): d is ElementResponse =>
    isApiResponse(d, 'element_type');

  return {
    id: data.id as PlayerStatId,
    eventId: isElementResponse(data) ? data.event_points : data.eventId,
    elementId: isElementResponse(data) ? data.id : data.elementId,
    teamId: isElementResponse(data) ? data.team : data.teamId,
    form: isElementResponse(data) ? (data.form ? Number(data.form) : null) : data.form,
    influence: isElementResponse(data)
      ? data.influence
        ? Number(data.influence)
        : null
      : data.influence,
    creativity: isElementResponse(data)
      ? data.creativity
        ? Number(data.creativity)
        : null
      : data.creativity,
    threat: isElementResponse(data) ? (data.threat ? Number(data.threat) : null) : data.threat,
    ictIndex: isElementResponse(data)
      ? data.ict_index
        ? Number(data.ict_index)
        : null
      : data.ictIndex,
    expectedGoals: isElementResponse(data)
      ? data.expected_goals
        ? new Prisma.Decimal(data.expected_goals)
        : null
      : data.expectedGoals,
    expectedAssists: isElementResponse(data)
      ? data.expected_assists
        ? new Prisma.Decimal(data.expected_assists)
        : null
      : data.expectedAssists,
    expectedGoalInvolvements: isElementResponse(data)
      ? data.expected_goal_involvements
        ? new Prisma.Decimal(data.expected_goal_involvements)
        : null
      : data.expectedGoalInvolvements,
    expectedGoalsConceded: isElementResponse(data)
      ? data.expected_goals_conceded
        ? new Prisma.Decimal(data.expected_goals_conceded)
        : null
      : data.expectedGoalsConceded,
    minutes: isElementResponse(data) ? data.minutes : data.minutes,
    goalsScored: isElementResponse(data) ? data.goals_scored : data.goalsScored,
    assists: isElementResponse(data) ? data.assists : data.assists,
    cleanSheets: isElementResponse(data) ? data.clean_sheets : data.cleanSheets,
    goalsConceded: isElementResponse(data) ? data.goals_conceded : data.goalsConceded,
    ownGoals: isElementResponse(data) ? data.own_goals : data.ownGoals,
    penaltiesSaved: isElementResponse(data) ? data.penalties_saved : data.penaltiesSaved,
    yellowCards: isElementResponse(data) ? data.yellow_cards : data.yellowCards,
    redCards: isElementResponse(data) ? data.red_cards : data.redCards,
    saves: isElementResponse(data) ? data.saves : data.saves,
    bonus: isElementResponse(data) ? data.bonus : data.bonus,
    bps: isElementResponse(data) ? data.bps : data.bps,
    starts: isElementResponse(data) ? data.starts : data.starts,
    influenceRank: isElementResponse(data) ? data.influence_rank : data.influenceRank,
    influenceRankType: isElementResponse(data) ? data.influence_rank_type : data.influenceRankType,
    creativityRank: isElementResponse(data) ? data.creativity_rank : data.creativityRank,
    creativityRankType: isElementResponse(data)
      ? data.creativity_rank_type
      : data.creativityRankType,
    threatRank: isElementResponse(data) ? data.threat_rank : data.threatRank,
    threatRankType: isElementResponse(data) ? data.threat_rank_type : data.threatRankType,
    ictIndexRank: isElementResponse(data) ? data.ict_index_rank : data.ictIndexRank,
    ictIndexRankType: isElementResponse(data) ? data.ict_index_rank_type : data.ictIndexRankType,
    expectedGoalsPer90: isElementResponse(data) ? null : data.expectedGoalsPer90,
    savesPer90: isElementResponse(data) ? null : data.savesPer90,
    expectedAssistsPer90: isElementResponse(data) ? null : data.expectedAssistsPer90,
    expectedGoalInvolvementsPer90: isElementResponse(data)
      ? null
      : data.expectedGoalInvolvementsPer90,
  };
};

export const toPrismaPlayerStat = (stat: PlayerStat): PrismaPlayerStatCreate => ({
  eventId: stat.eventId,
  elementId: stat.elementId,
  teamId: stat.teamId,
  form: stat.form,
  influence: stat.influence,
  creativity: stat.creativity,
  threat: stat.threat,
  ictIndex: stat.ictIndex,
  expectedGoals: stat.expectedGoals,
  expectedAssists: stat.expectedAssists,
  expectedGoalInvolvements: stat.expectedGoalInvolvements,
  expectedGoalsConceded: stat.expectedGoalsConceded,
  minutes: stat.minutes,
  goalsScored: stat.goalsScored,
  assists: stat.assists,
  cleanSheets: stat.cleanSheets,
  goalsConceded: stat.goalsConceded,
  ownGoals: stat.ownGoals,
  penaltiesSaved: stat.penaltiesSaved,
  yellowCards: stat.yellowCards,
  redCards: stat.redCards,
  saves: stat.saves,
  bonus: stat.bonus,
  bps: stat.bps,
  starts: stat.starts,
  influenceRank: stat.influenceRank,
  influenceRankType: stat.influenceRankType,
  creativityRank: stat.creativityRank,
  creativityRankType: stat.creativityRankType,
  threatRank: stat.threatRank,
  threatRankType: stat.threatRankType,
  ictIndexRank: stat.ictIndexRank,
  ictIndexRankType: stat.ictIndexRankType,
  expectedGoalsPer90: stat.expectedGoalsPer90,
  savesPer90: stat.savesPer90,
  expectedAssistsPer90: stat.expectedAssistsPer90,
  expectedGoalInvolvementsPer90: stat.expectedGoalInvolvementsPer90,
});

export const convertPrismaPlayerStats = (
  playerStats: readonly PrismaPlayerStat[],
): TE.TaskEither<APIError, PlayerStats> =>
  pipe(
    playerStats,
    TE.right,
    TE.map((stats) => stats.map(toDomainPlayerStat)),
  );

export const convertPrismaPlayerStat = (
  playerStat: PrismaPlayerStat | null,
): TE.TaskEither<APIError, PlayerStat | null> =>
  TE.right(playerStat ? toDomainPlayerStat(playerStat) : null);
