import { z } from 'zod';

export const PhaseResponseSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    start_event: z.number(),
    stop_event: z.number(),
    highest_score: z.number().nullable(),
    start_time: z.string().optional(),
    stop_time: z.string().optional(),
  })
  .passthrough();

export type PhaseResponse = z.infer<typeof PhaseResponseSchema>;
