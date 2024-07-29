import { z } from 'zod';

const PhaseSchema = z.object({
  id: z.number(),
  name: z.string(),
  start_event: z.number(),
  stop_event: z.number(),
});

const PhasesSchema = z.array(PhaseSchema);

type Phase = z.infer<typeof PhaseSchema>;

type Phases = z.infer<typeof PhasesSchema>;

export { Phase, Phases, PhaseSchema, PhasesSchema };
