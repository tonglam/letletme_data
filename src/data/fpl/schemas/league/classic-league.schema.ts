import { ClassicStandingsResponseSchema } from 'src/data/fpl/schemas/league/standing.schema';
import { z } from 'zod';

import { LeagueInfoResponseSchema } from './league-info.schema';

export const ClassicLeagueResponseSchema = z.object({
  league: LeagueInfoResponseSchema,
  standings: ClassicStandingsResponseSchema,
  last_updated_data: z.string(),
});
