import { z } from 'zod';

import { EntryHistoryInfoResponseSchema } from './info.schema';

export const EntryHistoryResponseSchema = z
  .object({
    past: z.array(EntryHistoryInfoResponseSchema),
  })
  .passthrough();

export type EntryHistoryResponse = z.infer<typeof EntryHistoryResponseSchema>;
