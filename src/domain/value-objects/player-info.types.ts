import { z } from 'zod';

export const PlayerInfo = z.object({
  id: z.number().int().positive(),
  code: z.number().int().positive(),
  name: z.string(),
  type: z.number().int().positive(),
  teamId: z.number().int().positive(),
  teamName: z.string(),
  teamShortName: z.string(),
  price: z.number().nonnegative(),
  webName: z.string(),
});

export type PlayerInfo = z.infer<typeof PlayerInfo>;
