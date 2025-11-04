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
  minutes: z.number().int().min(0).max(90).nullable(),
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
  bps: z.number().int().min(0).nullable(),
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
 * Calculate total points from individual stats
 * (For validation purposes - the API provides the actual value)
 */
export function calculateTotalPoints(eventLive: EventLive): number {
  let points = 0;

  // Minutes played
  if (eventLive.minutes !== null) {
    if (eventLive.minutes > 0 && eventLive.minutes < 60) {
      points += 1;
    } else if (eventLive.minutes >= 60) {
      points += 2;
    }
  }

  // Goals scored (varies by position)
  if (eventLive.goalsScored !== null) {
    points += eventLive.goalsScored * 4; // Simplified - actual scoring depends on player position
  }

  // Assists
  if (eventLive.assists !== null) {
    points += eventLive.assists * 3;
  }

  // Clean sheets (varies by position)
  if (eventLive.cleanSheets !== null && eventLive.cleanSheets > 0) {
    points += 4; // Simplified - actual scoring depends on player position
  }

  // Goals conceded (defenders and goalkeepers only)
  if (eventLive.goalsConceded !== null) {
    const goalsPenalty = Math.floor(eventLive.goalsConceded / 2);
    points -= goalsPenalty;
  }

  // Own goals
  if (eventLive.ownGoals !== null) {
    points -= eventLive.ownGoals * 2;
  }

  // Penalties saved
  if (eventLive.penaltiesSaved !== null) {
    points += eventLive.penaltiesSaved * 5;
  }

  // Penalties missed
  if (eventLive.penaltiesMissed !== null) {
    points -= eventLive.penaltiesMissed * 2;
  }

  // Yellow cards
  if (eventLive.yellowCards !== null) {
    points -= eventLive.yellowCards;
  }

  // Red cards
  if (eventLive.redCards !== null) {
    points -= eventLive.redCards * 3;
  }

  // Saves (goalkeepers only)
  if (eventLive.saves !== null) {
    points += Math.floor(eventLive.saves / 3);
  }

  // Bonus points
  if (eventLive.bonus !== null) {
    points += eventLive.bonus;
  }

  return Math.max(points, 0); // Minimum 0 points
}

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
