import { z } from 'zod';

import { EventLiveExplainResponseSchema } from './explain.schema';
import { LiveResponseSchema } from './live.schema';

export const ElementSchema = z
  .object({
    id: z.number(),
    stats: LiveResponseSchema,
    explain: z.array(EventLiveExplainResponseSchema),
  })
  .passthrough();

export const EventLiveResponseSchema = z
  .object({
    elements: z.array(ElementSchema),
  })
  .passthrough();

export type EventLiveResponse = z.infer<typeof EventLiveResponseSchema>;
