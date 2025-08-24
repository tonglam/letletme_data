import { validateRawFPLTeam, validateTeam } from '../domain/teams';
import { ValidationError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { RawFPLTeam, Team } from '../types';

/**
 * Transform FPL API team to our domain Team with validation
 */
export function transformTeam(rawTeam: RawFPLTeam): Team {
  try {
    // Validate raw FPL data first
    const validatedRawTeam = validateRawFPLTeam(rawTeam);

    // Transform to domain object
    const domainTeam: Team = {
      id: validatedRawTeam.id,
      name: validatedRawTeam.name,
      shortName: validatedRawTeam.short_name,
      code: validatedRawTeam.code,
      draw: validatedRawTeam.draw,
      form: validatedRawTeam.form,
      loss: validatedRawTeam.loss,
      played: validatedRawTeam.played,
      points: validatedRawTeam.points,
      position: validatedRawTeam.position,
      strength: validatedRawTeam.strength,
      teamDivision: validatedRawTeam.team_division,
      unavailable: validatedRawTeam.unavailable,
      win: validatedRawTeam.win,
      strengthOverallHome: validatedRawTeam.strength_overall_home,
      strengthOverallAway: validatedRawTeam.strength_overall_away,
      strengthAttackHome: validatedRawTeam.strength_attack_home,
      strengthAttackAway: validatedRawTeam.strength_attack_away,
      strengthDefenceHome: validatedRawTeam.strength_defence_home,
      strengthDefenceAway: validatedRawTeam.strength_defence_away,
      pulseId: validatedRawTeam.pulse_id,
    };

    // Validate the transformed domain object
    return validateTeam(domainTeam);
  } catch (error) {
    logError('Failed to transform team', error, { teamId: rawTeam.id, teamName: rawTeam.name });
    throw new ValidationError(
      `Failed to transform team with id: ${rawTeam.id}`,
      'TRANSFORM_ERROR',
      error,
    );
  }
}

/**
 * Transform array of teams with comprehensive error handling
 */
export function transformTeams(rawTeams: RawFPLTeam[]): Team[] {
  const teams: Team[] = [];
  const errors: Array<{ teamId: number; error: string }> = [];

  for (const rawTeam of rawTeams) {
    try {
      const transformedTeam = transformTeam(rawTeam);
      teams.push(transformedTeam);
    } catch (error) {
      errors.push({
        teamId: rawTeam.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      logError('Skipping invalid team during transformation', error, { teamId: rawTeam.id });
    }
  }

  if (errors.length > 0) {
    logError('Some teams failed transformation', {
      totalTeams: rawTeams.length,
      successfulTransforms: teams.length,
      failedTransforms: errors.length,
      errors: errors,
    });
  }

  if (teams.length === 0) {
    throw new ValidationError('No valid teams were transformed', 'ALL_TEAMS_INVALID', {
      originalCount: rawTeams.length,
      errors,
    });
  }

  logInfo('Teams transformation completed', {
    totalInput: rawTeams.length,
    successfulOutput: teams.length,
    skippedCount: errors.length,
  });

  return teams;
}
