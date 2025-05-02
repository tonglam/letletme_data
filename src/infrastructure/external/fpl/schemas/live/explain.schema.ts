import { z } from 'zod';

export const StatSchema = z
  .object({
    identifier: z.string(),
    points: z.number(),
    value: z.number(),
    points_modification: z.number(),
  })
  .passthrough();

export const EventLiveExplainResponseSchema = z
  .object({
    fixture: z.number(),
    stats: z.array(StatSchema),
  })
  .passthrough();

export type StatResponse = z.infer<typeof StatSchema>;
export type EventLiveExplainResponse = z.infer<typeof EventLiveExplainResponseSchema>;
