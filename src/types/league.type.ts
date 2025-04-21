import { z } from 'zod';

const LeagueStandingSchema = z.object({
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

const LeagueSchema = z.object({
  id: z.number(),
  name: z.string(),
  created: z.string(),
  closed: z.boolean(),
  max_entries: z.number().nullable(),
  league_type: z.string(),
  scoring: z.string(),
  admin_entry: z.number().nullable(),
  start_event: z.number(),
  code_privacy: z.string(),
  has_cup: z.boolean(),
  cup_league: z.number().nullable(),
  rank: z.number().nullable(),
});

export const ClassicLeagueResponseSchema = z.object({
  league: LeagueSchema,
  new_entries: z.object({
    has_next: z.boolean(),
    page: z.number(),
    results: z.array(z.unknown()),
  }),
  standings: z.object({
    has_next: z.boolean(),
    page: z.number(),
    results: z.array(LeagueStandingSchema),
  }),
});

export const H2hLeagueResponseSchema = z.object({
  league: LeagueSchema,
  new_entries: z.object({
    has_next: z.boolean(),
    page: z.number(),
    results: z.array(z.unknown()),
  }),
  standings: z.object({
    has_next: z.boolean(),
    page: z.number(),
    results: z.array(
      LeagueStandingSchema.extend({
        matches_won: z.number(),
        matches_drawn: z.number(),
        matches_lost: z.number(),
        points_for: z.number(),
      }),
    ),
  }),
});

export const CupResponseSchema = z.object({
  // TODO: Add proper schema based on API response
  matches: z.array(
    z.object({
      id: z.number(),
      entry_1_entry: z.number(),
      entry_1_name: z.string(),
      entry_1_player_name: z.string(),
      entry_1_points: z.number(),
      entry_1_win: z.number(),
      entry_1_draw: z.number(),
      entry_1_loss: z.number(),
      entry_2_entry: z.number(),
      entry_2_name: z.string(),
      entry_2_player_name: z.string(),
      entry_2_points: z.number(),
      entry_2_win: z.number(),
      entry_2_draw: z.number(),
      entry_2_loss: z.number(),
      is_knockout: z.boolean(),
      winner: z.number().nullable(),
      seed_value: z.number().nullable(),
      event: z.number(),
      tiebreak: z.number().nullable(),
    }),
  ),
});

export type ClassicLeagueResponse = z.infer<typeof ClassicLeagueResponseSchema>;
export type H2hLeagueResponse = z.infer<typeof H2hLeagueResponseSchema>;
export type CupResponse = z.infer<typeof CupResponseSchema>;
