import { z } from 'zod';

export const TeamResponseSchema = z
  .object({
    // Required fields (must exist in API response)
    id: z.number(),
    code: z.number(),
    name: z.string(),
    short_name: z.string(),
    strength: z.number(),
    strength_overall_home: z.number(),
    strength_overall_away: z.number(),
    strength_attack_home: z.number(),
    strength_attack_away: z.number(),
    strength_defence_home: z.number(),
    strength_defence_away: z.number(),
    pulse_id: z.number(),
    played: z.number(),
    position: z.number(),
    points: z.number(),
    win: z.number(),
    draw: z.number(),
    loss: z.number(),
    unavailable: z.boolean(),

    // Optional fields (nullable in Prisma)
    form: z.string().nullable(),
    team_division: z.string().nullable(),

    // Other API fields that we don't store
    draw_rank: z.number().optional(),
    form_rank: z.number().optional(),
    loss_rank: z.number().optional(),
    played_rank: z.number().optional(),
    points_rank: z.number().optional(),
    position_rank: z.number().optional(),
    strength_rank: z.number().optional(),
    win_rank: z.number().optional(),
    strength_attack_rank: z.number().optional(),
    strength_defence_rank: z.number().optional(),
  })
  .passthrough();

export type TeamResponse = z.infer<typeof TeamResponseSchema>;
export type TeamsResponse = readonly TeamResponse[];
