import { z } from 'zod';

export const LeagueInfoResponseSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    start_event: z.number().nullable(),
    entry_rank: z.number().nullable(),
    entry_last_rank: z.number().nullable(),
  })
  .passthrough();

export type LeagueInfoResponse = z.infer<typeof LeagueInfoResponseSchema>;
