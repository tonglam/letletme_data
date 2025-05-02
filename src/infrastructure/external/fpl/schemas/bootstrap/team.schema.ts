import { z } from 'zod';

export const TeamResponseSchema = z
  .object({
    id: z.number(),
    code: z.number(),
    name: z.string(),
    short_name: z.string(),
    strength: z.number(),
    position: z.number(),
    points: z.number(),
    win: z.number(),
    draw: z.number(),
    loss: z.number(),
  })
  .passthrough();

export type TeamResponse = z.infer<typeof TeamResponseSchema>;
