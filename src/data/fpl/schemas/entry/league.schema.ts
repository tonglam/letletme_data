import { z } from 'zod';

import { LeagueInfoResponseSchema } from './league-info.schema';

export const EntryLeagueResponseSchema = z
  .object({
    classic: z.array(LeagueInfoResponseSchema),
    h2h: z.array(LeagueInfoResponseSchema),
  })
  .passthrough();

export type EntryLeagueResponse = z.infer<typeof EntryLeagueResponseSchema>;
