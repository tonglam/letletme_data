import { z } from 'zod';

export const TopElementInfoSchema = z.object({
  id: z.number().int().positive(),
  points: z.number().int().nonnegative(),
});

export type TopElementInfo = z.infer<typeof TopElementInfoSchema>;
