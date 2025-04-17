import { z } from 'zod';
import { ElementResponseSchema } from './element.schema';
import { EventResponseSchema } from './event.schema';
import { PhaseResponseSchema } from './phase.schema';
import { TeamResponseSchema } from './team.schema';

export const BootStrapResponseSchema = z
  .object({
    events: z.array(EventResponseSchema),
    phases: z.array(PhaseResponseSchema),
    teams: z.array(TeamResponseSchema),
    elements: z.array(ElementResponseSchema),
  })
  .passthrough();

export type BootStrapResponse = z.infer<typeof BootStrapResponseSchema>;
