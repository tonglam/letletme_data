import { Prisma } from '@prisma/client';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../infrastructure/http/common/errors';
import { BaseRepository } from './base.type';

// ============ Types ============
/**
 * Domain types (camelCase)
 */
export interface PlayerStat {
  readonly id: string;
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
  extends BaseRepository<PrismaPlayerStat, PrismaPlayerStatCreate, string> {
  /**
   * Finds player stats by element ID
   * @param elementId - The element ID to find stats for
   * @returns TaskEither with found player stats or error
   */
  findByElementId: (elementId: number) => TE.TaskEither<APIError, PrismaPlayerStat[]>;

  /**
   * Finds player stats by event ID
   * @param eventId - The event ID to find stats for
   * @returns TaskEither with found player stats or error
   */
  findByEventId: (eventId: number) => TE.TaskEither<APIError, PrismaPlayerStat[]>;

  /**
   * Finds player stats by element ID and event ID
   * @param elementId - The element ID to find stats for
   * @param eventId - The event ID to find stats for
   * @returns TaskEither with found player stat or null if not found
   */
  findByElementAndEvent: (
    elementId: number,
    eventId: number,
  ) => TE.TaskEither<APIError, PrismaPlayerStat | null>;

  /**
   * Finds player stats by team ID
   * @param teamId - The team ID to find stats for
   * @returns TaskEither with found player stats or error
   */
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

// ============ Converters ============
export const toDomainPlayerStat = (prisma: PrismaPlayerStat): PlayerStat => ({
  id: prisma.id,
  eventId: prisma.eventId,
  elementId: prisma.elementId,
  teamId: prisma.teamId,
  form: prisma.form,
  influence: prisma.influence,
  creativity: prisma.creativity,
  threat: prisma.threat,
  ictIndex: prisma.ictIndex,
  expectedGoals: prisma.expectedGoals?.toNumber() ?? null,
  expectedAssists: prisma.expectedAssists?.toNumber() ?? null,
  expectedGoalInvolvements: prisma.expectedGoalInvolvements?.toNumber() ?? null,
  expectedGoalsConceded: prisma.expectedGoalsConceded?.toNumber() ?? null,
  minutes: prisma.minutes,
  goalsScored: prisma.goalsScored,
  assists: prisma.assists,
  cleanSheets: prisma.cleanSheets,
  goalsConceded: prisma.goalsConceded,
  ownGoals: prisma.ownGoals,
  penaltiesSaved: prisma.penaltiesSaved,
  yellowCards: prisma.yellowCards,
  redCards: prisma.redCards,
  saves: prisma.saves,
  bonus: prisma.bonus,
  bps: prisma.bps,
  starts: prisma.starts,
  influenceRank: prisma.influenceRank,
  influenceRankType: prisma.influenceRankType,
  creativityRank: prisma.creativityRank,
  creativityRankType: prisma.creativityRankType,
  threatRank: prisma.threatRank,
  threatRankType: prisma.threatRankType,
  ictIndexRank: prisma.ictIndexRank,
  ictIndexRankType: prisma.ictIndexRankType,
  expectedGoalsPer90: prisma.expectedGoalsPer90?.toNumber() ?? null,
  savesPer90: prisma.savesPer90?.toNumber() ?? null,
  expectedAssistsPer90: prisma.expectedAssistsPer90?.toNumber() ?? null,
  expectedGoalInvolvementsPer90: prisma.expectedGoalInvolvementsPer90?.toNumber() ?? null,
  expectedGoalsConcededPer90: prisma.expectedGoalsConcededPer90?.toNumber() ?? null,
  goalsConcededPer90: prisma.goalsConcededPer90?.toNumber() ?? null,
  startsPer90: prisma.startsPer90?.toNumber() ?? null,
  cleanSheetsPer90: prisma.cleanSheetsPer90?.toNumber() ?? null,
  cornersAndIndirectFreekicksOrder: prisma.cornersAndIndirectFreekicksOrder,
  cornersAndIndirectFreekicksText: prisma.cornersAndIndirectFreekicksText,
  directFreekicksOrder: prisma.directFreekicksOrder,
  directFreekicksText: prisma.directFreekicksText,
  penaltiesOrder: prisma.penaltiesOrder,
  penaltiesText: prisma.penaltiesText,
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
