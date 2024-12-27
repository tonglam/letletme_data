import { z } from 'zod';

export const ElementSummaryResponseSchema = z.object({
  // TODO: Add proper schema based on API response
  fixtures: z.array(z.unknown()),
  history: z.array(z.unknown()),
  history_past: z.array(z.unknown()),
});

export type ElementSummaryResponse = z.infer<typeof ElementSummaryResponseSchema>;
