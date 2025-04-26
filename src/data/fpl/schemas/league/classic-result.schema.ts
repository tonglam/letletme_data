import { z } from 'zod';

export const ClassicResultResponseSchema = z.object({
  id: z.number(),
  event_total: z.number(),
  player_name: z.string(),
  rank: z.number(),
  last_rank: z.number(),
  rank_sort: z.number(),
  total: z.number(),
  entry: z.number(),
  entry_name: z.string(),
  has_played: z.boolean(),
});

export type ClassicResultResponse = z.infer<typeof ClassicResultResponseSchema>;
export type ClassicResultResponses = readonly ClassicResultResponse[];
