import { z } from 'zod';

import type { RawFPLTeam, Team } from '../types';

// ================================
// Domain Validation Schemas
// ================================

export const TeamSchema = z.object({
  id: z.number().int().positive('Team ID must be a positive integer'),
  name: z.string().min(1, 'Team name is required').max(50, 'Team name too long'),
  shortName: z.string().min(1, 'Short name is required').max(5, 'Short name too long'),
  code: z.number().int().positive('Team code must be a positive integer'),
  draw: z.number().int().min(0, 'Draw count cannot be negative'),
  form: z.string().nullable().optional(),
  loss: z.number().int().min(0, 'Loss count cannot be negative'),
  played: z.number().int().min(0, 'Played count cannot be negative'),
  points: z.number().int().min(0, 'Points cannot be negative'),
  position: z.number().int().min(1).max(20, 'Position must be between 1-20'),
  strength: z.number().int().min(1).max(5, 'Strength must be between 1-5'),
  teamDivision: z.number().int().nullable().optional(),
  unavailable: z.boolean(),
  win: z.number().int().min(0, 'Win count cannot be negative'),
  strengthOverallHome: z.number().int().min(1000).max(1500, 'Invalid strength value'),
  strengthOverallAway: z.number().int().min(1000).max(1500, 'Invalid strength value'),
  strengthAttackHome: z.number().int().min(1000).max(1500, 'Invalid strength value'),
  strengthAttackAway: z.number().int().min(1000).max(1500, 'Invalid strength value'),
  strengthDefenceHome: z.number().int().min(1000).max(1500, 'Invalid strength value'),
  strengthDefenceAway: z.number().int().min(1000).max(1500, 'Invalid strength value'),
  pulseId: z.number().int().positive('Pulse ID must be a positive integer'),
});

export const RawFPLTeamSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  short_name: z.string().min(1),
  code: z.number().int().positive(),
  draw: z.number().int().min(0),
  form: z.string().nullable().optional(),
  loss: z.number().int().min(0),
  played: z.number().int().min(0),
  points: z.number().int().min(0),
  position: z.number().int().min(1).max(20),
  strength: z.number().int().min(1).max(5),
  team_division: z.number().int().nullable().optional(),
  unavailable: z.boolean(),
  win: z.number().int().min(0),
  strength_overall_home: z.number().int(),
  strength_overall_away: z.number().int(),
  strength_attack_home: z.number().int(),
  strength_attack_away: z.number().int(),
  strength_defence_home: z.number().int(),
  strength_defence_away: z.number().int(),
  pulse_id: z.number().int().positive(),
});

// ================================
// Domain Business Logic
// ================================

/**
 * Check if a team is considered strong based on FPL strength rating
 */
export function isStrongTeam(team: Team): boolean {
  return team.strength >= 4;
}

/**
 * Check if a team is available for selection
 */
export function isTeamAvailable(team: Team): boolean {
  return !team.unavailable;
}

/**
 * Get team form rating (simplified)
 */
export function getFormRating(team: Team): 'excellent' | 'good' | 'average' | 'poor' | 'unknown' {
  if (!team.form) return 'unknown';

  // FPL form is typically a string like "WWDLW" (last 5 games)
  const wins = (team.form.match(/W/g) || []).length;
  const draws = (team.form.match(/D/g) || []).length;

  const formPoints = wins * 3 + draws * 1;

  if (formPoints >= 12) return 'excellent';
  if (formPoints >= 9) return 'good';
  if (formPoints >= 6) return 'average';
  return 'poor';
}

/**
 * Calculate team's home advantage factor
 */
export function getHomeAdvantage(team: Team): number {
  const homeStrength =
    (team.strengthOverallHome + team.strengthAttackHome + team.strengthDefenceHome) / 3;
  const awayStrength =
    (team.strengthOverallAway + team.strengthAttackAway + team.strengthDefenceAway) / 3;

  return homeStrength - awayStrength;
}

/**
 * Get team difficulty rating for attacking purposes
 */
export function getAttackingDifficulty(
  team: Team,
  isHome: boolean,
): 'very_easy' | 'easy' | 'medium' | 'hard' | 'very_hard' {
  const defenceStrength = isHome ? team.strengthDefenceHome : team.strengthDefenceAway;

  if (defenceStrength <= 1100) return 'very_easy';
  if (defenceStrength <= 1200) return 'easy';
  if (defenceStrength <= 1300) return 'medium';
  if (defenceStrength <= 1400) return 'hard';
  return 'very_hard';
}

/**
 * Get team difficulty rating for defensive purposes
 */
export function getDefensiveDifficulty(
  team: Team,
  isHome: boolean,
): 'very_easy' | 'easy' | 'medium' | 'hard' | 'very_hard' {
  const attackStrength = isHome ? team.strengthAttackHome : team.strengthAttackAway;

  if (attackStrength <= 1100) return 'very_easy';
  if (attackStrength <= 1200) return 'easy';
  if (attackStrength <= 1300) return 'medium';
  if (attackStrength <= 1400) return 'hard';
  return 'very_hard';
}

/**
 * Validate a team object against the domain schema
 */
export function validateTeam(team: unknown): Team {
  return TeamSchema.parse(team);
}

/**
 * Validate raw FPL team data
 */
export function validateRawFPLTeam(rawTeam: unknown): RawFPLTeam {
  return RawFPLTeamSchema.parse(rawTeam);
}

/**
 * Validate array of teams
 */
export function validateTeams(teams: unknown[]): Team[] {
  return teams.map(validateTeam);
}

/**
 * Check if team data has been recently updated (within last hour)
 */
export function isRecentlyUpdated(team: { updatedAt?: Date | string }): boolean {
  if (!team.updatedAt) return false;

  const updatedAt = team.updatedAt instanceof Date ? team.updatedAt : new Date(team.updatedAt);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  return updatedAt > hourAgo;
}

/**
 * Get teams by strength range
 */
export function filterTeamsByStrength(
  teams: Team[],
  minStrength: number,
  maxStrength?: number,
): Team[] {
  return teams.filter((team) => {
    if (maxStrength !== undefined) {
      return team.strength >= minStrength && team.strength <= maxStrength;
    }
    return team.strength >= minStrength;
  });
}

/**
 * Get top performing teams based on points and position
 */
export function getTopPerformingTeams(teams: Team[], count: number = 6): Team[] {
  return teams
    .filter(isTeamAvailable)
    .sort((a, b) => {
      // Sort by points (descending), then by position (ascending)
      if (a.points !== b.points) return b.points - a.points;
      return a.position - b.position;
    })
    .slice(0, count);
}

/**
 * Get teams in relegation zone (bottom 3 positions)
 */
export function getRelegationZoneTeams(teams: Team[]): Team[] {
  return teams.filter((team) => team.position >= 18).sort((a, b) => b.position - a.position);
}

// ================================
// Export type inference helpers
// ================================

export type ValidatedTeam = z.infer<typeof TeamSchema>;
export type ValidatedRawFPLTeam = z.infer<typeof RawFPLTeamSchema>;
