import { z } from 'zod';

import { EntryInfoResponseSchema } from './info.schema';
import { EntryLeagueResponseSchema } from './league.schema';

export const EntryResponseSchema = z
  .object({
    ...EntryInfoResponseSchema.shape,
    leagues: EntryLeagueResponseSchema,
  })
  .passthrough();

export type EntryResponse = z.infer<typeof EntryResponseSchema>;
