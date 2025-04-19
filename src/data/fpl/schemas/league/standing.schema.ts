import { ClassicResultResponseSchema } from 'src/data/fpl/schemas/league/classic-result.schema';
import { H2hResultResponseSchema } from 'src/data/fpl/schemas/league/h2h-result.schema';
import { z } from 'zod';

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
