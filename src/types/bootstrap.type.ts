// Type definitions and transformers for game data initialization.

import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import type { ElementResponse } from './element.type';
import { ElementResponseSchema } from './element.type';
import type { EventResponse } from './event.type';
import { EventResponseSchema } from './event.type';
import type { PhaseResponse } from './phase.type';
import { PhaseResponseSchema } from './phase.type';
import type { TeamResponse } from './team.type';
import { TeamResponseSchema } from './team.type';

// Zod schema for validating bootstrap response data
export const BootStrapResponseSchema = z
  .object({
    events: z.array(EventResponseSchema),
    phases: z.array(PhaseResponseSchema),
    teams: z.array(TeamResponseSchema),
    elements: z.array(ElementResponseSchema),
  })
  .passthrough();

// Type for raw API response, inferred from schema
export type BootStrapResponse = z.infer<typeof BootStrapResponseSchema>;

// Domain model for bootstrap data (strict interface for our application)
export interface BootStrap {
  readonly events: readonly EventResponse[];
  readonly phases: readonly PhaseResponse[];
  readonly teams: readonly TeamResponse[];
  readonly elements: readonly ElementResponse[];
}

// Generic array transformation utility
const transformArray = <T, U>(
  arr: T[],
  transform: (item: T) => E.Either<string, U>,
  entityName: string,
): E.Either<string, readonly U[]> =>
  pipe(
    arr,
    A.traverse(E.Applicative)(transform),
    E.mapLeft((error) => `Failed to transform ${entityName}: ${error}`),
  );

// Transforms raw bootstrap response data into domain model
export const toDomainBootStrap = (raw: BootStrapResponse): E.Either<string, BootStrap> =>
  pipe(
    E.Do,
    E.bind('events', () => transformArray(raw.events, (e) => E.right(e), 'events')),
    E.bind('phases', () => transformArray(raw.phases, (p) => E.right(p), 'phases')),
    E.bind('teams', () => transformArray(raw.teams, (t) => E.right(t), 'teams')),
    E.bind('elements', () => transformArray(raw.elements, (e) => E.right(e), 'elements')),
    E.map((data) => ({
      events: data.events,
      phases: data.phases,
      teams: data.teams,
      elements: data.elements,
    })),
    E.mapLeft((error) => `Failed to transform bootstrap data: ${error}`),
  );
