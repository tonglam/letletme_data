import { z } from 'zod';

import { ClassicResultResponseSchema } from './classic-result.schema';
import { H2hResultResponseSchema } from './h2h-result.schema';

export const ClassicStandingsResponseSchema = z.object({
  has_next: z.boolean(),
  page: z.number(),
  results: z.array(ClassicResultResponseSchema),
});

export const H2hStandingsResponseSchema = z.object({
  has_next: z.boolean(),
  page: z.number(),
  results: z.array(H2hResultResponseSchema),
});
