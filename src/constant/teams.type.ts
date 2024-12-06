import { z } from 'zod';

const TeamSchema = z.object({
  id: z.string(),
  teamId: z.number(),
  name: z.string(),
  shortName: z.string(),
  strength: z.number(),
  createdAt: z.string().transform((val) => new Date(val)),
});

// Additional fields from FPL API that aren't in the database model
const TeamStatsSchema = z.object({
  code: z.number(),
  draw: z.number(),
  form: z.string().nullable(),
  loss: z.number(),
  played: z.number(),
  points: z.number(),
  position: z.number(),
  teamDivision: z.string().nullable(),
  unavailable: z.boolean(),
  win: z.number(),
  strengthOverallHome: z.number(),
  strengthOverallAway: z.number(),
  strengthAttackHome: z.number(),
  strengthAttackAway: z.number(),
  strengthDefenceHome: z.number(),
  strengthDefenceAway: z.number(),
  pulseId: z.number(),
});

const TeamsSchema = z.array(TeamSchema);
const TeamStatsListSchema = z.array(TeamStatsSchema);

type Team = z.infer<typeof TeamSchema>;
type Teams = z.infer<typeof TeamsSchema>;
type TeamStats = z.infer<typeof TeamStatsSchema>;
type TeamStatsList = z.infer<typeof TeamStatsListSchema>;

export {
  Team,
  Teams,
  TeamSchema,
  TeamsSchema,
  TeamStats,
  TeamStatsList,
  TeamStatsListSchema,
  TeamStatsSchema,
};
