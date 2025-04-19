import { z } from 'zod';

export const PhaseResponseSchema = z
  .object({
    // Required fields (must exist in API response)
    id: z.number(),
    name: z.string(),
    start_event: z.number(),
    stop_event: z.number(),

    // Optional fields (nullable in Prisma)
    highest_score: z.number().nullable(),

    // Other API fields that we don't store
    start_time: z.string().optional(),
    stop_time: z.string().optional(),
  })
  .passthrough();

export type PhaseResponse = z.infer<typeof PhaseResponseSchema>;
