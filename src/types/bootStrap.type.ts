import { Either, left, right } from 'fp-ts/Either';
import { z } from 'zod';
import { Element, ElementsResponseSchema, ElementsSchema, toDomainElement } from './element.type';
import { Event, EventsResponseSchema, EventsSchema, toDomainEvent } from './events.type';
import { Phase, PhasesResponseSchema, PhasesSchema, toDomainPhase } from './phases.type';
import { Team, TeamsResponseSchema, TeamsSchema, toDomainTeam } from './teams.type';

// ============ Schemas ============
/**
 * API Response Schema - Validates external API data (snake_case)
 */
export const BootStrapResponseSchema = z
  .object({
    events: EventsResponseSchema,
    phases: PhasesResponseSchema,
    teams: TeamsResponseSchema,
    elements: ElementsResponseSchema,
  })
  .passthrough();

/**
 * Domain Schema - Internal application model (camelCase)
 */
export const BootStrapSchema = z
  .object({
    events: EventsSchema,
    phases: PhasesSchema,
    teams: TeamsSchema,
    elements: ElementsSchema,
  })
  .passthrough();

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type BootStrapResponse = z.infer<typeof BootStrapResponseSchema>;

/**
 * Domain types (camelCase)
 */
export type BootStrap = z.infer<typeof BootStrapSchema>;

// ============ Type Transformers ============
/**
 * Transform and validate BootStrapResponse to BootStrap
 */
export const toDomainBootStrap = (raw: BootStrapResponse): Either<string, BootStrap> => {
  try {
    // Transform each section using their respective transformers
    const eventsResults = raw.events.map(toDomainEvent);
    const phasesResults = raw.phases.map(toDomainPhase);
    const teamsResults = raw.teams.map(toDomainTeam);
    const elementsResults = raw.elements.map(toDomainElement);

    // Check for any transformation errors
    const errors: string[] = [];
    const events: Event[] = [];
    const phases: Phase[] = [];
    const teams: Team[] = [];
    const elements: Element[] = [];

    eventsResults.forEach((result) => {
      if (result._tag === 'Left') errors.push(result.left);
      else events.push(result.right);
    });

    phasesResults.forEach((result) => {
      if (result._tag === 'Left') errors.push(result.left);
      else phases.push(result.right);
    });

    teamsResults.forEach((result) => {
      if (result._tag === 'Left') errors.push(result.left);
      else teams.push(result.right);
    });

    elementsResults.forEach((result) => {
      if (result._tag === 'Left') errors.push(result.left);
      else elements.push(result.right);
    });

    if (errors.length > 0) {
      return left(`Failed to transform bootstrap data: ${errors.join(', ')}`);
    }

    const result = BootStrapSchema.safeParse({
      events,
      phases,
      teams,
      elements,
    });

    return result.success
      ? right(result.data)
      : left(`Invalid bootstrap domain model: ${result.error.message}`);
  } catch (error) {
    return left(
      `Failed to transform bootstrap data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
