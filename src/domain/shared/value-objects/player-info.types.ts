import { PlayerIDSchema, TeamIDSchema } from '@app/domain/shared/types/id.types';
import { PlayerTypeIDSchema } from '@app/domain/shared/types/type.types';
import { z } from 'zod';

export const PlayerInfoSchema = z.object({
  id: PlayerIDSchema,
  code: z.number().int().positive(),
  name: z.string(),
  type: PlayerTypeIDSchema,
  teamId: TeamIDSchema,
  teamName: z.string(),
  teamShortName: z.string(),
  price: z.number().nonnegative(),
  webName: z.string(),
});

export type PlayerInfo = z.infer<typeof PlayerInfoSchema>;
