import { z } from 'zod';

const TeamSchema = z.object({
  code: z.number(),
  draw: z.number(),
  form: z.nullable(z.string()),
  id: z.number(),
  loss: z.number(),
  name: z.string(),
  played: z.number(),
  points: z.number(),
  position: z.number(),
  short_name: z.string(),
  strength: z.number(),
  team_division: z.nullable(z.string()),
  unavailable: z.boolean(),
  win: z.number(),
  strength_overall_home: z.number(),
  strength_overall_away: z.number(),
  strength_attack_home: z.number(),
  strength_attack_away: z.number(),
  strength_defence_home: z.number(),
  strength_defence_away: z.number(),
  pulse_id: z.number(),
});

const TeamsSchema = z.array(TeamSchema);

type Team = z.infer<typeof TeamSchema>;

type Teams = z.infer<typeof TeamsSchema>;

export { Team, TeamSchema, Teams, TeamsSchema };
