import { z } from 'zod';

export const EntryInfoResponseSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    player_first_name: z.string(),
    player_last_name: z.string(),
    player_region_name: z.string(),
    started_event: z.number(),
    summary_overall_points: z.number(),
    summary_overall_rank: z.number(),
    last_deadline_bank: z.number(),
    last_deadline_value: z.number(),
    last_deadline_total_transfers: z.number(),
  })
  .passthrough();

export type EntryInfoResponse = z.infer<typeof EntryInfoResponseSchema>;
