import { z } from 'zod';

export const LiveResponseSchema = z
  .object({
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
    starts: z.number(),
    expected_goals: z.string(),
    expected_assists: z.string(),
    expected_goal_involvements: z.string(),
    expected_goals_conceded: z.string(),
    mng_win: z.number().nullable(),
    mng_draw: z.number().nullable(),
    mng_loss: z.number().nullable(),
    mng_underdog_win: z.number().nullable(),
    mng_underdog_draw: z.number().nullable(),
    mng_clean_sheets: z.number().nullable(),
    mng_goals_scored: z.number().nullable(),
    total_points: z.number(),
    in_dreamteam: z.boolean().nullable(),
  })
  .passthrough();

export type LiveResponse = z.infer<typeof LiveResponseSchema>;
