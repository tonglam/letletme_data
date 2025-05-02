import { z } from 'zod';

import { LeagueInfoResponseSchema } from './league-info.schema';
import { ClassicStandingsResponseSchema } from './standing.schema';

export const ClassicLeagueResponseSchema = z.object({
  league: LeagueInfoResponseSchema,
  standings: ClassicStandingsResponseSchema,
  last_updated_data: z.string(),
});

export type ClassicLeagueResponse = z.infer<typeof ClassicLeagueResponseSchema>;
