import { LeagueInfoResponseSchema } from 'src/data/fpl/schemas/entry/league-info.schema';
import { z } from 'zod';

export const EntryLeagueResponseSchema = z
  .object({
    classic: z.array(LeagueInfoResponseSchema),
    h2h: z.array(LeagueInfoResponseSchema),
  })
  .passthrough();

export type EntryLeagueResponse = z.infer<typeof EntryLeagueResponseSchema>;
