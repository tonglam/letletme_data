import { z } from 'zod';

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
  played: z.number().default(0),
  position: z.number().default(0),
  points: z.number().default(0),
  form: z.string().nullable(),
  win: z.number().default(0),
  draw: z.number().default(0),
  loss: z.number().default(0),
  teamDivision: z.string().nullable(),
  unavailable: z.boolean().default(false),
});

const TeamsSchema = z.array(TeamSchema);
const TeamsResponseSchema = z.array(TeamResponseSchema);

type TeamResponse = z.infer<typeof TeamResponseSchema>;
type TeamsResponse = z.infer<typeof TeamsResponseSchema>;
type Team = z.infer<typeof TeamSchema>;
type Teams = z.infer<typeof TeamsSchema>;

export {
  Team,
  TeamResponse,
  TeamResponseSchema,
  Teams,
  TeamSchema,
  TeamsResponse,
  TeamsResponseSchema,
  TeamsSchema,
};
