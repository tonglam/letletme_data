import { z } from 'zod';

const PhaseSchema = z.object({
  id: z.string(),
  phaseId: z.number(),
  name: z.string(),
  startEvent: z.number(),
  stopEvent: z.number(),
  createdAt: z.string().transform((val) => new Date(val)),
  updatedAt: z.string().transform((val) => new Date(val)),
});

const PhasesSchema = z.array(PhaseSchema);

type Phase = z.infer<typeof PhaseSchema>;

type Phases = z.infer<typeof PhasesSchema>;

export { Phase, Phases, PhaseSchema, PhasesSchema };
