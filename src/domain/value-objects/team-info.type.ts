import { z } from 'zod';

export const TeamInfo = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  shortName: z.string(),
  position: z.number().int().positive(),
});

export type TeamInfo = z.infer<typeof TeamInfo>;
