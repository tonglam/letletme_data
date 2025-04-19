import { z } from 'zod';

export const PickElementResponseSchema = z
  .object({
    element: z.number(),
    position: z.number(),
    multiplier: z.number(),
    is_captain: z.boolean(),
    is_vice_captain: z.boolean(),
    element_type: z.number(),
  })
  .passthrough();

export const PickResponseSchema = z
  .object({
    entry: z.number(),
    event: z.number(),
    active_chip: z.string().nullable(),
    picks: z.array(PickElementResponseSchema).nullable(),
  })
  .passthrough();

export type PickResponse = z.infer<typeof PickResponseSchema>;
