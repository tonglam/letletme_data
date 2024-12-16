import { z } from 'zod';
import { ElementsResponseSchema, ElementsSchema } from './element.type';
import { EventSchema, EventsResponseSchema } from './events.type';
import { PhasesResponseSchema, PhasesSchema } from './phase.type';
import { TeamsResponseSchema, TeamsSchema } from './teams.type';

const BootStrapResponseSchema = z
  .object({
    events: EventsResponseSchema,
    phases: PhasesResponseSchema,
    teams: TeamsResponseSchema,
    elements: ElementsResponseSchema,
  })
  .passthrough();

const BootStrapSchema = z
  .object({
    events: z.array(EventSchema),
    phases: PhasesSchema,
    teams: TeamsSchema,
    elements: ElementsSchema,
  })
  .passthrough();

type BootStrapResponse = z.infer<typeof BootStrapResponseSchema>;
type BootStrap = z.infer<typeof BootStrapSchema>;

export { BootStrap, BootStrapResponse, BootStrapResponseSchema, BootStrapSchema };
