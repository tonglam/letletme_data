import { z } from 'zod';

import type { ElementTypeId, PlayerId } from '../types/base.type';

export interface EventLiveSummary {
  readonly elementId: PlayerId;
  readonly elementType: ElementTypeId;
  readonly minutes: number;
  readonly goalsScored: number;
  readonly assists: number;
  readonly cleanSheets: number;
  readonly goalsConceded: number;
  readonly ownGoals: number;
  readonly penaltiesSaved: number;
  readonly penaltiesMissed: number;
  readonly yellowCards: number;
  readonly redCards: number;
  readonly saves: number;
  readonly bonus: number;
  readonly bps: number;
  readonly totalPoints: number;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}

export type EventLiveSummaries = readonly EventLiveSummary[];

export const EventLiveSummarySchema = z.object({
  elementId: z.number().int().positive(),
  elementType: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  minutes: z.number().int().min(0),
  goalsScored: z.number().int().min(0),
  assists: z.number().int().min(0),
  cleanSheets: z.number().int().min(0),
  goalsConceded: z.number().int().min(0),
  ownGoals: z.number().int().min(0),
  penaltiesSaved: z.number().int().min(0),
  penaltiesMissed: z.number().int().min(0),
  yellowCards: z.number().int().min(0),
  redCards: z.number().int().min(0),
  saves: z.number().int().min(0),
  bonus: z.number().int().min(0),
  // FPL can return negative BPS for poor performances; do not clamp at 0.
  bps: z.number().int(),
  totalPoints: z.number().int(),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
});

export const EventLiveSummariesSchema = z.array(EventLiveSummarySchema);

export function validateEventLiveSummary(data: unknown): EventLiveSummary {
  return EventLiveSummarySchema.parse(data);
}

export function validateEventLiveSummaries(data: unknown): EventLiveSummaries {
  return EventLiveSummariesSchema.parse(data);
}

export function safeValidateEventLiveSummary(data: unknown): EventLiveSummary | null {
  const result = EventLiveSummarySchema.safeParse(data);
  return result.success ? result.data : null;
}

export function hasPlayed(summary: EventLiveSummary): boolean {
  return summary.minutes > 0;
}

export function hasGoalInvolvement(summary: EventLiveSummary): boolean {
  return summary.goalsScored > 0 || summary.assists > 0;
}

export function hasBonusPoints(summary: EventLiveSummary): boolean {
  return summary.bonus > 0;
}
