import { z } from 'zod';

import type { ElementTypeId, ElementTypeName, EventId, PlayerId, TeamId } from '../types/base.type';

// ================================
// Domain Types
// ================================

export interface PlayerStat {
  readonly eventId: EventId;
  readonly elementId: PlayerId;
  readonly webName: string;
  readonly elementType: ElementTypeId;
  readonly elementTypeName: ElementTypeName;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly value: number;
  readonly totalPoints: number | null;
  readonly form: string | null;
  readonly influence: string | null;
  readonly creativity: string | null;
  readonly threat: string | null;
  readonly ictIndex: string | null;
  readonly expectedGoals: string | null;
  readonly expectedAssists: string | null;
  readonly expectedGoalInvolvements: string | null;
  readonly expectedGoalsConceded: string | null;
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

export type RawPlayerStat = Omit<
  PlayerStat,
  'webName' | 'elementTypeName' | 'teamId' | 'teamName' | 'teamShortName' | 'value'
>;
export type RawPlayerStats = readonly RawPlayerStat[];

// ================================
// Domain Validation Schemas
// ================================

export const PlayerStatSchema = z.object({
  eventId: z.number().int().positive('Event ID must be a positive integer'),
  elementId: z.number().int().positive('Element ID must be a positive integer'),
  webName: z.string().min(1, 'Web name is required').max(30, 'Web name too long'),
  elementType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)], {
    errorMap: () => ({ message: 'Element type must be 1-4 (GKP=1, DEF=2, MID=3, FWD=4)' }),
  }),
  elementTypeName: z.enum(['GKP', 'DEF', 'MID', 'FWD'], {
    errorMap: () => ({ message: 'Element type name must be GKP, DEF, MID, or FWD' }),
  }),
  teamId: z.number().int().positive('Team ID must be a positive integer'),
  teamName: z.string().min(1, 'Team name is required').max(50, 'Team name too long'),
  teamShortName: z
    .string()
    .min(1, 'Team short name is required')
    .max(10, 'Team short name too long'),
  value: z
    .number()
    .int()
    .min(35, 'Value must be at least 3.5m')
    .max(150, 'Value cannot exceed 15.0m'),
  totalPoints: z.number().int().nullable(),
  form: z.string().nullable(),
  influence: z.string().nullable(),
  creativity: z.string().nullable(),
  threat: z.string().nullable(),
  ictIndex: z.string().nullable(),
  expectedGoals: z.string().nullable(),
  expectedAssists: z.string().nullable(),
  expectedGoalInvolvements: z.string().nullable(),
  expectedGoalsConceded: z.string().nullable(),
  minutes: z.number().int().min(0, 'Minutes cannot be negative').nullable(),
  goalsScored: z.number().int().min(0, 'Goals scored cannot be negative').nullable(),
  assists: z.number().int().min(0, 'Assists cannot be negative').nullable(),
  cleanSheets: z.number().int().min(0, 'Clean sheets cannot be negative').nullable(),
  goalsConceded: z.number().int().min(0, 'Goals conceded cannot be negative').nullable(),
  ownGoals: z.number().int().min(0, 'Own goals cannot be negative').nullable(),
  penaltiesSaved: z.number().int().min(0, 'Penalties saved cannot be negative').nullable(),
  yellowCards: z.number().int().min(0, 'Yellow cards cannot be negative').nullable(),
  redCards: z.number().int().min(0, 'Red cards cannot be negative').nullable(),
  saves: z.number().int().min(0, 'Saves cannot be negative').nullable(),
  bonus: z.number().int().min(0, 'Bonus cannot be negative').nullable(),
  bps: z.number().int().nullable(),
  starts: z.number().int().min(0, 'Starts cannot be negative').nullable(),
  influenceRank: z.number().int().positive('Influence rank must be positive').nullable(),
  influenceRankType: z.number().int().positive('Influence rank type must be positive').nullable(),
  creativityRank: z.number().int().positive('Creativity rank must be positive').nullable(),
  creativityRankType: z.number().int().positive('Creativity rank type must be positive').nullable(),
  threatRank: z.number().int().positive('Threat rank must be positive').nullable(),
  threatRankType: z.number().int().positive('Threat rank type must be positive').nullable(),
  ictIndexRank: z.number().int().positive('ICT index rank must be positive').nullable(),
  ictIndexRankType: z.number().int().positive('ICT index rank type must be positive').nullable(),
  mngWin: z.number().int().min(0, 'Manager win cannot be negative').nullable(),
  mngDraw: z.number().int().min(0, 'Manager draw cannot be negative').nullable(),
  mngLoss: z.number().int().min(0, 'Manager loss cannot be negative').nullable(),
  mngUnderdogWin: z.number().int().min(0, 'Manager underdog win cannot be negative').nullable(),
  mngUnderdogDraw: z.number().int().min(0, 'Manager underdog draw cannot be negative').nullable(),
  mngCleanSheets: z.number().int().min(0, 'Manager clean sheets cannot be negative').nullable(),
  mngGoalsScored: z.number().int().min(0, 'Manager goals scored cannot be negative').nullable(),
});

export const RawPlayerStatSchema = PlayerStatSchema.omit({
  webName: true,
  elementTypeName: true,
  teamId: true,
  teamName: true,
  teamShortName: true,
  value: true,
});

// ================================
// Domain Business Logic
// ================================

/**
 * Calculate player's points per million value
 */
export function getPointsPerMillion(playerStat: PlayerStat): number | null {
  if (playerStat.totalPoints === null || playerStat.value <= 0) {
    return null;
  }
  return playerStat.totalPoints / (playerStat.value / 10);
}

/**
 * Calculate form as a number
 */
export function getFormAsNumber(playerStat: PlayerStat): number | null {
  if (!playerStat.form) return null;
  const form = parseFloat(playerStat.form);
  return isNaN(form) ? null : form;
}

/**
 * Get player's form rating
 */
export function getFormRating(
  playerStat: PlayerStat,
): 'excellent' | 'good' | 'average' | 'poor' | 'unknown' {
  const form = getFormAsNumber(playerStat);
  if (form === null) return 'unknown';

  if (form >= 5.0) return 'excellent';
  if (form >= 3.5) return 'good';
  if (form >= 2.0) return 'average';
  return 'poor';
}

/**
 * Calculate expected goals as number
 */
export function getExpectedGoalsAsNumber(playerStat: PlayerStat): number | null {
  if (!playerStat.expectedGoals) return null;
  const xg = parseFloat(playerStat.expectedGoals);
  return isNaN(xg) ? null : xg;
}

/**
 * Calculate expected assists as number
 */
export function getExpectedAssistsAsNumber(playerStat: PlayerStat): number | null {
  if (!playerStat.expectedAssists) return null;
  const xa = parseFloat(playerStat.expectedAssists);
  return isNaN(xa) ? null : xa;
}

/**
 * Calculate ICT Index as number
 */
export function getIctIndexAsNumber(playerStat: PlayerStat): number | null {
  if (!playerStat.ictIndex) return null;
  const ict = parseFloat(playerStat.ictIndex);
  return isNaN(ict) ? null : ict;
}

/**
 * Check if player is a regular starter (>75% of minutes)
 */
export function isRegularStarter(playerStat: PlayerStat, maxMinutesInEvent: number = 90): boolean {
  if (playerStat.minutes === null || playerStat.starts === null) return false;
  const expectedMinutes = playerStat.starts * maxMinutesInEvent * 0.75;
  return playerStat.minutes >= expectedMinutes;
}

/**
 * Check if player has good value (points per million > threshold)
 */
export function hasGoodValue(playerStat: PlayerStat, threshold: number = 10): boolean {
  const pointsPerMillion = getPointsPerMillion(playerStat);
  return pointsPerMillion !== null && pointsPerMillion >= threshold;
}

/**
 * Get attacking returns (goals + assists)
 */
export function getAttackingReturns(playerStat: PlayerStat): number | null {
  const goals = playerStat.goalsScored ?? 0;
  const assists = playerStat.assists ?? 0;

  if (playerStat.goalsScored === null && playerStat.assists === null) {
    return null;
  }

  return goals + assists;
}

/**
 * Check if player is a differential pick (based on value and form)
 */
export function isDifferentialPick(playerStat: PlayerStat): boolean {
  const form = getFormAsNumber(playerStat);
  const pointsPerMillion = getPointsPerMillion(playerStat);

  if (form === null || pointsPerMillion === null) return false;

  // Good form (>= 3) and good value (>= 8 points per million)
  return form >= 3.0 && pointsPerMillion >= 8.0 && playerStat.value <= 80; // Max 8.0m
}

/**
 * Get defensive returns (clean sheets for defenders/goalkeepers, or saves for goalkeepers)
 */
export function getDefensiveReturns(playerStat: PlayerStat): number | null {
  // For goalkeepers, prioritize saves
  if (playerStat.elementType === 1 && playerStat.saves !== null) {
    return playerStat.saves;
  }

  // For defenders and other positions, return clean sheets
  return playerStat.cleanSheets;
}

/**
 * Filter player stats by position
 */
export function filterPlayerStatsByPosition(
  playerStats: PlayerStats,
  elementType: ElementTypeId,
): PlayerStats {
  return playerStats.filter((stat) => stat.elementType === elementType);
}

/**
 * Filter player stats by team
 */
export function filterPlayerStatsByTeam(playerStats: PlayerStats, teamId: TeamId): PlayerStats {
  return playerStats.filter((stat) => stat.teamId === teamId);
}

/**
 * Sort player stats by total points (descending)
 */
export function sortPlayerStatsByPoints(playerStats: PlayerStats): PlayerStats {
  return [...playerStats].sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0));
}

/**
 * Sort player stats by value (ascending)
 */
export function sortPlayerStatsByValue(playerStats: PlayerStats): PlayerStats {
  return [...playerStats].sort((a, b) => a.value - b.value);
}

/**
 * Sort player stats by points per million (descending)
 */
export function sortPlayerStatsByPointsPerMillion(playerStats: PlayerStats): PlayerStats {
  return [...playerStats].sort((a, b) => {
    const aPPM = getPointsPerMillion(a) ?? -1;
    const bPPM = getPointsPerMillion(b) ?? -1;
    return bPPM - aPPM;
  });
}

// ================================
// Validation Functions
// ================================

/**
 * Validate a player stat object against the domain schema
 */
export function validatePlayerStat(playerStat: unknown): PlayerStat {
  return PlayerStatSchema.parse(playerStat);
}

/**
 * Validate raw player stat data
 */
export function validateRawPlayerStat(rawPlayerStat: unknown): RawPlayerStat {
  return RawPlayerStatSchema.parse(rawPlayerStat);
}

/**
 * Validate array of player stats
 */
export function validatePlayerStats(playerStats: unknown[]): PlayerStats {
  return playerStats.map(validatePlayerStat);
}

/**
 * Check if player stat data has been recently updated (within last hour)
 */
export function isRecentlyUpdated(playerStat: { updatedAt?: Date | string }): boolean {
  if (!playerStat.updatedAt) return false;

  const updatedAt =
    playerStat.updatedAt instanceof Date ? playerStat.updatedAt : new Date(playerStat.updatedAt);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  return updatedAt > hourAgo;
}

// ================================
// Export type inference helpers
// ================================

export type ValidatedPlayerStat = z.infer<typeof PlayerStatSchema>;
export type ValidatedRawPlayerStat = z.infer<typeof RawPlayerStatSchema>;
