import { z } from 'zod';

export const EntryHistoryInfoResponseSchema = z
  .object({
    season_name: z.string(),
    total_points: z.number(),
    rank: z.number(),
  })
  .passthrough();

export type EntryHistoryInfoResponse = z.infer<typeof EntryHistoryInfoResponseSchema>;
