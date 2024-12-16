import { z } from 'zod';

const PhaseResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  start_event: z.number(),
  stop_event: z.number(),
  highest_score: z.number().nullable(),
});

const PhaseSchema = z.object({
  id: z.number(),
  name: z.string(),
  startEvent: z.number(),
  stopEvent: z.number(),
  highestScore: z.number().nullable(),
});

const PhasesSchema = z.array(PhaseSchema);
const PhasesResponseSchema = z.array(PhaseResponseSchema);

type PhaseResponse = z.infer<typeof PhaseResponseSchema>;
type PhasesResponse = z.infer<typeof PhasesResponseSchema>;
type Phase = z.infer<typeof PhaseSchema>;
type Phases = z.infer<typeof PhasesSchema>;

export {
  Phase,
  PhaseResponse,
  PhaseResponseSchema,
  Phases,
  PhaseSchema,
  PhasesResponse,
  PhasesResponseSchema,
  PhasesSchema,
};
