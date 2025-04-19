import { z } from 'zod';

export const H2hResultResponseSchema = z.object({
  id: z.number(),
  division: z.number(),
  entry: z.number(),
  player_name: z.string(),
  rank: z.number(),
  last_rank: z.number(),
  rank_sort: z.number(),
  total: z.number(),
  entry_name: z.string(),
  matches_played: z.number(),
  matches_won: z.number(),
  matches_drawn: z.number(),
  matches_lost: z.number(),
  points_for: z.number(),
});
