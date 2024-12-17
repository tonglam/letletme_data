import { Either, left, right } from 'fp-ts/Either';
import { z } from 'zod';

// ============ Schemas ============
/**
 * API Response Schema - Validates external API data (snake_case)
 */
export const PhaseResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  start_event: z.number(),
  stop_event: z.number(),
  highest_score: z.number().nullable(),
});

/**
 * Domain Schema - Internal application model (camelCase)
 */
export const PhaseSchema = z.object({
  id: z.number(),
  name: z.string(),
  startEvent: z.number(),
  stopEvent: z.number(),
  highestScore: z.number().nullable(),
});

export const PhasesSchema = z.array(PhaseSchema);
export const PhasesResponseSchema = z.array(PhaseResponseSchema);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type PhaseResponse = z.infer<typeof PhaseResponseSchema>;
export type PhasesResponse = z.infer<typeof PhasesResponseSchema>;

/**
 * Domain types (camelCase)
 */
export type Phase = z.infer<typeof PhaseSchema>;
export type Phases = z.infer<typeof PhasesSchema>;

// ============ Type Transformers ============
/**
 * Transform and validate PhaseResponse to Phase
 */
export const toDomainPhase = (raw: PhaseResponse): Either<string, Phase> => {
  const result = PhaseSchema.safeParse({
    id: raw.id,
    name: raw.name,
    startEvent: raw.start_event,
    stopEvent: raw.stop_event,
    highestScore: raw.highest_score,
  });

  return result.success
    ? right(result.data)
    : left(`Invalid domain model: ${result.error.message}`);
};
