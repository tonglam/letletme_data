import { z } from 'zod';

import { LeagueInfoResponseSchema } from './league-info.schema';
import { H2hStandingsResponseSchema } from './standing.schema';

export const H2hLeagueResponseSchema = z.object({
  league: LeagueInfoResponseSchema,
  standings: H2hStandingsResponseSchema,
  last_updated_data: z.string(),
});

export type H2hLeagueResponse = z.infer<typeof H2hLeagueResponseSchema>;
