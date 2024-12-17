import { Either, left, right } from 'fp-ts/Either';
import { z } from 'zod';

// ============ Schemas ============
/**
 * API Response Schema - Validates external API data (snake_case)
 */
const TeamResponseSchema = z.object({
  id: z.number(),
  code: z.number(),
  name: z.string(),
  short_name: z.string(),
  strength: z.number(),
  strength_overall_home: z.number(),
  strength_overall_away: z.number(),
  strength_attack_home: z.number(),
  strength_attack_away: z.number(),
  strength_defence_home: z.number(),
  strength_defence_away: z.number(),
  pulse_id: z.number(),
  played: z.number(),
  position: z.number(),
  points: z.number(),
  form: z.string().nullable(),
  win: z.number(),
  draw: z.number(),
  loss: z.number(),
  team_division: z.string().nullable(),
  unavailable: z.boolean(),
});

/**
 * Domain Schema - Internal application model (camelCase)
 */
const TeamSchema = z.object({
  id: z.number(),
  code: z.number(),
  name: z.string(),
  shortName: z.string(),
  strength: z.number(),
  strengthOverallHome: z.number(),
  strengthOverallAway: z.number(),
  strengthAttackHome: z.number(),
  strengthAttackAway: z.number(),
  strengthDefenceHome: z.number(),
  strengthDefenceAway: z.number(),
  pulseId: z.number(),
  played: z.number(),
  position: z.number(),
  points: z.number(),
  form: z.string().nullable(),
  win: z.number(),
  draw: z.number(),
  loss: z.number(),
  teamDivision: z.string().nullable(),
  unavailable: z.boolean(),
});

export const TeamsSchema = z.array(TeamSchema);
export const TeamsResponseSchema = z.array(TeamResponseSchema);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type TeamResponse = z.infer<typeof TeamResponseSchema>;
export type TeamsResponse = z.infer<typeof TeamsResponseSchema>;

/**
 * Domain types (camelCase)
 */
export type Team = z.infer<typeof TeamSchema>;
export type Teams = z.infer<typeof TeamsSchema>;

// ============ Type Transformers ============
/**
 * Transform and validate TeamResponse to Team
 */
export const toDomainTeam = (raw: TeamResponse): Either<string, Team> => {
  try {
    const result = TeamSchema.safeParse({
      id: raw.id,
      code: raw.code,
      name: raw.name,
      shortName: raw.short_name,
      strength: raw.strength,
      strengthOverallHome: raw.strength_overall_home,
      strengthOverallAway: raw.strength_overall_away,
      strengthAttackHome: raw.strength_attack_home,
      strengthAttackAway: raw.strength_attack_away,
      strengthDefenceHome: raw.strength_defence_home,
      strengthDefenceAway: raw.strength_defence_away,
      pulseId: raw.pulse_id,
      played: raw.played,
      position: raw.position,
      points: raw.points,
      form: raw.form,
      win: raw.win,
      draw: raw.draw,
      loss: raw.loss,
      teamDivision: raw.team_division,
      unavailable: raw.unavailable,
    });

    return result.success
      ? right(result.data)
      : left(`Invalid team domain model: ${result.error.message}`);
  } catch (error) {
    return left(
      `Failed to transform team data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
