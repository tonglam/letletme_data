/**
 * @fileoverview Bootstrap types and transformers for handling game data initialization.
 * This module provides type definitions and transformation utilities for bootstrap data
 * from the API to domain models.
 * @module types/bootstrap
 */

import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { z } from 'zod';
import type { ElementResponse } from './elements.type';
import type { EventResponse } from './events.type';
import type { PhaseResponse } from './phases.type';
import type { TeamResponse } from './teams.type';

/**
 * Zod schema for validating bootstrap response data.
 * Ensures the API response matches the expected structure.
 */
export const BootStrapResponseSchema = z.object({
  events: z.array(z.custom<EventResponse>()),
  phases: z.array(z.custom<PhaseResponse>()),
  teams: z.array(z.custom<TeamResponse>()),
  elements: z.array(z.custom<ElementResponse>()),
});

// ============ Types ============
/**
 * Represents the raw API response structure for bootstrap data.
 * @interface BootStrapResponse
 * @property {EventResponse[]} events - Array of event data from the API
 * @property {PhaseResponse[]} phases - Array of phase data from the API
 * @property {TeamResponse[]} teams - Array of team data from the API
 * @property {ElementResponse[]} elements - Array of element data from the API
 */
export interface BootStrapResponse {
  readonly events: EventResponse[];
  readonly phases: PhaseResponse[];
  readonly teams: TeamResponse[];
  readonly elements: ElementResponse[];
}

/**
 * Represents the domain model for bootstrap data after transformation.
 * Uses readonly arrays to ensure immutability in the domain layer.
 * @interface BootStrap
 * @property {readonly EventResponse[]} events - Immutable array of event data
 * @property {readonly PhaseResponse[]} phases - Immutable array of phase data
 * @property {readonly TeamResponse[]} teams - Immutable array of team data
 * @property {readonly ElementResponse[]} elements - Immutable array of element data
 */
export interface BootStrap {
  readonly events: readonly EventResponse[];
  readonly phases: readonly PhaseResponse[];
  readonly teams: readonly TeamResponse[];
  readonly elements: readonly ElementResponse[];
}

// ============ Type Transformers ============
/**
 * Generic array transformation utility that handles error cases.
 * @template T - Source type
 * @template U - Target type
 * @param {T[]} arr - Array of source items to transform
 * @param {function(T): Either<string, U>} transform - Transformation function
 * @param {string} entityName - Name of the entity being transformed for error messages
 * @returns {Either<string, readonly U[]>} Either an error message or the transformed array
 */
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

/**
 * Transforms raw bootstrap response data into the domain model.
 * Uses fp-ts for functional error handling and transformation.
 * @param {BootStrapResponse} raw - Raw bootstrap data from the API
 * @returns {Either<string, BootStrap>} Either an error message or the transformed bootstrap data
 */
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
