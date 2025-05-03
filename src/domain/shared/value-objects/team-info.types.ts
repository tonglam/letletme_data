import { TeamIDSchema } from '@app/domain/shared/types/id.types';
import { z } from 'zod';

export const TeamInfoSchema = z.object({
  id: TeamIDSchema,
  name: z.string(),
  shortName: z.string(),
  position: z.number().int().positive(),
});

export type TeamInfo = z.infer<typeof TeamInfoSchema>;
