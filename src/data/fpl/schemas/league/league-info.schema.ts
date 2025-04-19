import { z } from 'zod';

export const LeagueInfoResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  created: z.string(),
  closed: z.boolean(),
  max_entries: z.number(),
  league_type: z.string(),
  scoring: z.string(),
  admin_entry: z.number().nullable(),
  start_event: z.number(),
  code_privacy: z.string(),
  has_cup: z.boolean().nullable(),
  cup_league: z.number().nullable(),
  rank: z.number().nullable(),
  ko_rounds: z.number().nullable(),
});
