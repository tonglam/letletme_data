import { z } from 'zod';

export const EventLiveResponseSchema = z.object({
  // TODO: Add proper schema based on API response
  elements: z.array(
    z.object({
      id: z.number(),
      stats: z.object({
        minutes: z.number(),
        goals_scored: z.number(),
        assists: z.number(),
        clean_sheets: z.number(),
        goals_conceded: z.number(),
        own_goals: z.number(),
        penalties_saved: z.number(),
        penalties_missed: z.number(),
        yellow_cards: z.number(),
        red_cards: z.number(),
        saves: z.number(),
        bonus: z.number(),
        bps: z.number(),
      }),
      explain: z.array(z.unknown()),
    }),
  ),
});

export const EventPicksResponseSchema = z.object({
  // TODO: Add proper schema based on API response
  entry_history: z.object({
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
  picks: z.array(
    z.object({
      element: z.number(),
      position: z.number(),
      multiplier: z.number(),
      is_captain: z.boolean(),
      is_vice_captain: z.boolean(),
    }),
  ),
});

export type EventLiveResponse = z.infer<typeof EventLiveResponseSchema>;
export type EventPicksResponse = z.infer<typeof EventPicksResponseSchema>;
