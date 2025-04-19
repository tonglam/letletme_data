import { z } from 'zod';
import { EventLiveExplainResponseSchema } from './explain.schema';
import { EventLiveResponseSchema } from './live.schema';

export const ElementSchema = z
  .object({
    id: z.number(),
    stats: z.record(EventLiveResponseSchema),
    explain: z.array(EventLiveExplainResponseSchema),
  })
  .passthrough();

export const EventResponseSchema = z
  .object({
    elements: z.array(ElementSchema),
  })
  .passthrough();

export type EventResponse = z.infer<typeof EventResponseSchema>;
