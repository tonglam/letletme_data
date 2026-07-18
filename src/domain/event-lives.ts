import { z } from 'zod';

import type { EventId, PlayerId } from '../types/base.type';

// ================================
// Domain Types
// ================================

/**
 * EventLive - Live performance data for a player in a specific event
 *
 * Contains real-time match statistics updated during and after matches
 */
export interface EventLive {
  readonly eventId: EventId;
  readonly elementId: PlayerId;
  readonly minutes: number | null;
  readonly goalsScored: number | null;
  readonly assists: number | null;
  readonly cleanSheets: number | null;
  readonly goalsConceded: number | null;
  readonly ownGoals: number | null;
  readonly penaltiesSaved: number | null;
  readonly penaltiesMissed: number | null;
  readonly yellowCards: number | null;
  readonly redCards: number | null;
  readonly saves: number | null;
  readonly bonus: number | null;
  readonly bps: number | null;
  readonly defensiveContribution: number | null;
  readonly starts: boolean | null;
  readonly expectedGoals: string | null;
  readonly expectedAssists: string | null;
  readonly expectedGoalInvolvements: string | null;
  readonly expectedGoalsConceded: string | null;
  readonly inDreamTeam: boolean | null;
  readonly totalPoints: number;
  readonly createdAt: Date | null;
}

export type EventLives = readonly EventLive[];

// ================================
// Validation Schemas
// ================================

/**
 * Zod schema for EventLive domain validation
 */
export const EventLiveSchema = z.object({
  eventId: z.number().int().positive(),
  elementId: z.number().int().positive(),
  // max 150: extra time (90+30) + stoppage; penalties don't count as minutes.
  minutes: z.number().int().min(0).max(150).nullable(),
  goalsScored: z.number().int().min(0).nullable(),
  assists: z.number().int().min(0).nullable(),
  cleanSheets: z.number().int().min(0).max(1).nullable(),
  goalsConceded: z.number().int().min(0).nullable(),
  ownGoals: z.number().int().min(0).nullable(),
  penaltiesSaved: z.number().int().min(0).nullable(),
  penaltiesMissed: z.number().int().min(0).nullable(),
  yellowCards: z.number().int().min(0).max(2).nullable(),
  redCards: z.number().int().min(0).max(1).nullable(),
  saves: z.number().int().min(0).nullable(),
  bonus: z.number().int().min(0).max(3).nullable(),
  // FPL can return negative BPS for poor performances; do not clamp at 0.
  bps: z.number().int().nullable(),
  defensiveContribution: z.number().int().min(0).nullable(),
  starts: z.boolean().nullable(),
  expectedGoals: z.string().nullable(),
  expectedAssists: z.string().nullable(),
  expectedGoalInvolvements: z.string().nullable(),
  expectedGoalsConceded: z.string().nullable(),
  inDreamTeam: z.boolean().nullable(),
  totalPoints: z.number().int(),
  createdAt: z.date().nullable(),
});

export const EventLivesSchema = z.array(EventLiveSchema);

// ================================
// Domain Validation Functions
// ================================

/**
 * Validate a single EventLive object
 */
export function validateEventLive(data: unknown): EventLive {
  return EventLiveSchema.parse(data);
}

/**
 * Validate an array of EventLive objects
 */
export function validateEventLives(data: unknown): EventLives {
  return EventLivesSchema.parse(data);
}

/**
 * Safe validation that returns null on failure
 */
export function safeValidateEventLive(data: unknown): EventLive | null {
  const result = EventLiveSchema.safeParse(data);
  return result.success ? result.data : null;
}

// ================================
// Domain Business Logic
// ================================

/**
 * Check if a player played in the event
 */
export function hasPlayed(eventLive: EventLive): boolean {
  return (eventLive.minutes ?? 0) > 0;
}

/**
 * Check if a player started the match
 */
export function hasStarted(eventLive: EventLive): boolean {
  return eventLive.starts === true;
}

/**
 * Check if a player came off the bench
 */
export function cameOffBench(eventLive: EventLive): boolean {
  return hasPlayed(eventLive) && !hasStarted(eventLive);
}

/**
 * Check if a player received a card
 */
export function hasCard(eventLive: EventLive): boolean {
  return (eventLive.yellowCards ?? 0) > 0 || (eventLive.redCards ?? 0) > 0;
}

/**
 * Check if a player was sent off
 */
export function wasSentOff(eventLive: EventLive): boolean {
  return (eventLive.redCards ?? 0) > 0;
}

/**
 * Check if a player had a goal involvement (goal or assist)
 */
export function hasGoalInvolvement(eventLive: EventLive): boolean {
  return (eventLive.goalsScored ?? 0) > 0 || (eventLive.assists ?? 0) > 0;
}

/**
 * Check if a player earned bonus points
 */
export function hasBonusPoints(eventLive: EventLive): boolean {
  return (eventLive.bonus ?? 0) > 0;
}

/**
 * Check if a player is in the dream team
 */
export function isInDreamTeam(eventLive: EventLive): boolean {
  return eventLive.inDreamTeam === true;
}

/**
 * Get performance summary
 */
export function getPerformanceSummary(eventLive: EventLive): {
  played: boolean;
  started: boolean;
  points: number;
  goals: number;
  assists: number;
  cleanSheet: boolean;
  cards: { yellow: number; red: number };
  bonus: number;
} {
  return {
    played: hasPlayed(eventLive),
    started: hasStarted(eventLive),
    points: eventLive.totalPoints,
    goals: eventLive.goalsScored ?? 0,
    assists: eventLive.assists ?? 0,
    cleanSheet: (eventLive.cleanSheets ?? 0) > 0,
    cards: {
      yellow: eventLive.yellowCards ?? 0,
      red: eventLive.redCards ?? 0,
    },
    bonus: eventLive.bonus ?? 0,
  };
}
