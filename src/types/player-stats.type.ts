import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { APIError } from '../infrastructure/http/common/errors';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from './base.type';
import { ElementResponse } from './elements.type';

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
/**
 * Domain types (camelCase)
 */
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
  readonly expectedGoals: number | null;
  readonly expectedAssists: number | null;
  readonly expectedGoalInvolvements: number | null;
  readonly expectedGoalsConceded: number | null;
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
  readonly expectedGoalsPer90: number | null;
  readonly savesPer90: number | null;
  readonly expectedAssistsPer90: number | null;
  readonly expectedGoalInvolvementsPer90: number | null;
  readonly expectedGoalsConcededPer90: number | null;
  readonly goalsConcededPer90: number | null;
  readonly startsPer90: number | null;
  readonly cleanSheetsPer90: number | null;
  readonly cornersAndIndirectFreekicksOrder: number | null;
  readonly cornersAndIndirectFreekicksText: string | null;
  readonly directFreekicksOrder: number | null;
  readonly directFreekicksText: string | null;
  readonly penaltiesOrder: number | null;
  readonly penaltiesText: string | null;
}

export type PlayerStats = readonly PlayerStat[];

// ============ Repository Interface ============
export interface PlayerStatRepository
  extends BaseRepository<PrismaPlayerStat, PrismaPlayerStatCreate, PlayerStatId> {
  findByElementId: (elementId: number) => TE.TaskEither<APIError, PrismaPlayerStat[]>;
  findByEventId: (eventId: number) => TE.TaskEither<APIError, PrismaPlayerStat[]>;
  findByElementAndEvent: (
    elementId: number,
    eventId: number,
  ) => TE.TaskEither<APIError, PrismaPlayerStat | null>;
  findByTeamId: (teamId: number) => TE.TaskEither<APIError, PrismaPlayerStat[]>;
}

// ============ Persistence Types ============
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
  readonly expectedGoalsConcededPer90: Prisma.Decimal | null;
  readonly goalsConcededPer90: Prisma.Decimal | null;
  readonly startsPer90: Prisma.Decimal | null;
  readonly cleanSheetsPer90: Prisma.Decimal | null;
  readonly cornersAndIndirectFreekicksOrder: number | null;
  readonly cornersAndIndirectFreekicksText: string | null;
  readonly directFreekicksOrder: number | null;
  readonly directFreekicksText: string | null;
  readonly penaltiesOrder: number | null;
  readonly penaltiesText: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type PrismaPlayerStatCreate = Omit<PrismaPlayerStat, 'id' | 'createdAt' | 'updatedAt'>;
export type PrismaPlayerStatUpdate = Omit<PrismaPlayerStat, 'id' | 'createdAt' | 'updatedAt'>;

// ============ Converters ============
export const toDomainPlayerStat = (data: ElementResponse | PrismaPlayerStat): PlayerStat => {
  const isElementResponse = (d: ElementResponse | PrismaPlayerStat): d is ElementResponse =>
    isApiResponse(d, 'element_type');

  const parseNumber = (value: string | null): number | null => (value ? parseFloat(value) : null);

  return {
    id: data.id as PlayerStatId,
    eventId: isElementResponse(data) ? data.event_points : data.eventId,
    elementId: isElementResponse(data) ? data.id : data.elementId,
    teamId: isElementResponse(data) ? data.team : data.teamId,
    form: isElementResponse(data) ? parseNumber(data.form) : data.form,
    influence: isElementResponse(data) ? parseNumber(data.influence) : data.influence,
    creativity: isElementResponse(data) ? parseNumber(data.creativity) : data.creativity,
    threat: isElementResponse(data) ? parseNumber(data.threat) : data.threat,
    ictIndex: isElementResponse(data) ? parseNumber(data.ict_index) : data.ictIndex,
    expectedGoals: isElementResponse(data)
      ? parseNumber(data.expected_goals)
      : data.expectedGoals?.toNumber() ?? null,
    expectedAssists: isElementResponse(data)
      ? parseNumber(data.expected_assists)
      : data.expectedAssists?.toNumber() ?? null,
    expectedGoalInvolvements: isElementResponse(data)
      ? parseNumber(data.expected_goal_involvements)
      : data.expectedGoalInvolvements?.toNumber() ?? null,
    expectedGoalsConceded: isElementResponse(data)
      ? parseNumber(data.expected_goals_conceded)
      : data.expectedGoalsConceded?.toNumber() ?? null,
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
    expectedGoalsPer90: null, // Not available in ElementResponse
    savesPer90: null, // Not available in ElementResponse
    expectedAssistsPer90: null, // Not available in ElementResponse
    expectedGoalInvolvementsPer90: null, // Not available in ElementResponse
    expectedGoalsConcededPer90: null, // Not available in ElementResponse
    goalsConcededPer90: null, // Not available in ElementResponse
    startsPer90: null, // Not available in ElementResponse
    cleanSheetsPer90: null, // Not available in ElementResponse
    cornersAndIndirectFreekicksOrder: isElementResponse(data)
      ? data.corners_and_indirect_freekicks_order
      : data.cornersAndIndirectFreekicksOrder,
    cornersAndIndirectFreekicksText: isElementResponse(data)
      ? data.corners_and_indirect_freekicks_text
      : data.cornersAndIndirectFreekicksText,
    directFreekicksOrder: isElementResponse(data)
      ? data.direct_freekicks_order
      : data.directFreekicksOrder,
    directFreekicksText: isElementResponse(data)
      ? data.direct_freekicks_text
      : data.directFreekicksText,
    penaltiesOrder: isElementResponse(data) ? data.penalties_order : data.penaltiesOrder,
    penaltiesText: null, // Not available in ElementResponse
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
  expectedGoals: stat.expectedGoals ? new Prisma.Decimal(stat.expectedGoals) : null,
  expectedAssists: stat.expectedAssists ? new Prisma.Decimal(stat.expectedAssists) : null,
  expectedGoalInvolvements: stat.expectedGoalInvolvements
    ? new Prisma.Decimal(stat.expectedGoalInvolvements)
    : null,
  expectedGoalsConceded: stat.expectedGoalsConceded
    ? new Prisma.Decimal(stat.expectedGoalsConceded)
    : null,
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
  expectedGoalsPer90: stat.expectedGoalsPer90 ? new Prisma.Decimal(stat.expectedGoalsPer90) : null,
  savesPer90: stat.savesPer90 ? new Prisma.Decimal(stat.savesPer90) : null,
  expectedAssistsPer90: stat.expectedAssistsPer90
    ? new Prisma.Decimal(stat.expectedAssistsPer90)
    : null,
  expectedGoalInvolvementsPer90: stat.expectedGoalInvolvementsPer90
    ? new Prisma.Decimal(stat.expectedGoalInvolvementsPer90)
    : null,
  expectedGoalsConcededPer90: stat.expectedGoalsConcededPer90
    ? new Prisma.Decimal(stat.expectedGoalsConcededPer90)
    : null,
  goalsConcededPer90: stat.goalsConcededPer90 ? new Prisma.Decimal(stat.goalsConcededPer90) : null,
  startsPer90: stat.startsPer90 ? new Prisma.Decimal(stat.startsPer90) : null,
  cleanSheetsPer90: stat.cleanSheetsPer90 ? new Prisma.Decimal(stat.cleanSheetsPer90) : null,
  cornersAndIndirectFreekicksOrder: stat.cornersAndIndirectFreekicksOrder,
  cornersAndIndirectFreekicksText: stat.cornersAndIndirectFreekicksText,
  directFreekicksOrder: stat.directFreekicksOrder,
  directFreekicksText: stat.directFreekicksText,
  penaltiesOrder: stat.penaltiesOrder,
  penaltiesText: stat.penaltiesText,
});

export const convertPrismaPlayerStats = (
  playerStats: readonly PrismaPlayerStat[],
): TE.TaskEither<APIError, PlayerStats> =>
  pipe(
    playerStats,
    TE.right,
    TE.map((values) => values.map(toDomainPlayerStat)),
  );

export const convertPrismaPlayerStat = (
  playerStat: PrismaPlayerStat | null,
): TE.TaskEither<APIError, PlayerStat | null> =>
  TE.right(playerStat ? toDomainPlayerStat(playerStat) : null);
