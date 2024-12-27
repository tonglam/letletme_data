import { z } from 'zod';

export const EntryResponseSchema = z.object({
  // TODO: Add proper schema based on API response
  id: z.number(),
  joined_time: z.string(),
  started_event: z.number(),
  favourite_team: z.number(),
  player_first_name: z.string(),
  player_last_name: z.string(),
  player_region_id: z.number(),
  player_region_name: z.string(),
  player_region_iso_code_short: z.string(),
  summary_overall_points: z.number(),
  summary_overall_rank: z.number(),
  summary_event_points: z.number(),
  current_event: z.number(),
  leagues: z.object({
    classic: z.array(z.unknown()),
    h2h: z.array(z.unknown()),
    cup: z.unknown(),
  }),
  name: z.string(),
});

export const EntryTransfersResponseSchema = z.array(
  z.object({
    // TODO: Add proper schema based on API response
    element_in: z.number(),
    element_out: z.number(),
    entry: z.number(),
    event: z.number(),
    time: z.string(),
  }),
);

export const EntryHistoryResponseSchema = z.object({
  // TODO: Add proper schema based on API response
  current: z.array(
    z.object({
      event: z.number(),
      points: z.number(),
      total_points: z.number(),
      rank: z.number(),
      rank_sort: z.number(),
      overall_rank: z.number(),
      bank: z.number(),
      value: z.number(),
      event_transfers: z.number(),
      event_transfers_cost: z.number(),
      points_on_bench: z.number(),
    }),
  ),
  past: z.array(
    z.object({
      season_name: z.string(),
      total_points: z.number(),
      rank: z.number(),
    }),
  ),
  chips: z.array(
    z.object({
      name: z.string(),
      time: z.string(),
      event: z.number(),
    }),
  ),
});

export type EntryResponse = z.infer<typeof EntryResponseSchema>;
export type EntryTransfersResponse = z.infer<typeof EntryTransfersResponseSchema>;
export type EntryHistoryResponse = z.infer<typeof EntryHistoryResponseSchema>;
