/**
 * Core event types
 */
export interface EventDeadline {
  readonly id: number;
  readonly deadlineTime: string;
  readonly deadlineTimeEpoch: number;
}

/**
 * Result type for event queries
 */
export type EventQueryResult = {
  readonly currentEventId: number;
  readonly isValid: boolean;
  readonly error?: string;
};
