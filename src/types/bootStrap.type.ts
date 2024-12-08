import { z } from 'zod';
import { ElementsSchema } from './element.type';
import { EventsSchema } from './events.type';
import { PhasesSchema } from './phase.type';
import { TeamsSchema } from './teams.type';

const BootStrapSchema = z.object({
  events: EventsSchema,
  phases: PhasesSchema,
  teams: TeamsSchema,
  elements: ElementsSchema,
});

type BootStrap = z.infer<typeof BootStrapSchema>;

export { BootStrap, BootStrapSchema };
