import { z } from 'zod';

/**
 * Player value change types
 */
export type PlayerValueChangeType = 'Start' | 'Rise' | 'Fall';

/**
 * Player value domain model
 */
export interface PlayerValue {
  readonly elementId: number;
  readonly elementType: number;
  readonly eventId: number;
  readonly value: number;
  readonly lastValue: number;
  readonly changeDate: string;
  readonly changeType: PlayerValueChangeType;
}

/**
 * Player value response from API
 */
export interface PlayerValueResponse {
  readonly id: number;
  readonly element_type: number;
  readonly now_cost: number;
}

/**
 * Zod schema for player value response validation
 */
export const PlayerValueResponseSchema = z.object({
  id: z.number(),
  element_type: z.number(),
  now_cost: z.number(),
});
