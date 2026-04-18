import { z } from 'zod';

export interface EventLiveExplain {
  readonly eventId: number;
  readonly elementId: number;
  readonly bonus: number | null;
  readonly minutes: number | null;
  readonly minutesPoints: number | null;
  readonly goalsScored: number | null;
  readonly goalsScoredPoints: number | null;
  readonly assists: number | null;
  readonly assistsPoints: number | null;
  readonly cleanSheets: number | null;
  readonly cleanSheetsPoints: number | null;
  readonly goalsConceded: number | null;
  readonly goalsConcededPoints: number | null;
  readonly ownGoals: number | null;
  readonly ownGoalsPoints: number | null;
  readonly penaltiesSaved: number | null;
  readonly penaltiesSavedPoints: number | null;
  readonly penaltiesMissed: number | null;
  readonly penaltiesMissedPoints: number | null;
  readonly yellowCards: number | null;
  readonly yellowCardsPoints: number | null;
  readonly redCards: number | null;
  readonly redCardsPoints: number | null;
  readonly saves: number | null;
  readonly savesPoints: number | null;
}

export type EventLiveExplains = readonly EventLiveExplain[];

const nullableInt = z.number().int().nullable();

export const EventLiveExplainSchema = z.object({
  eventId: z.number().int().positive(),
  elementId: z.number().int().positive(),
  bonus: nullableInt,
  minutes: nullableInt,
  minutesPoints: nullableInt,
  goalsScored: nullableInt,
  goalsScoredPoints: nullableInt,
  assists: nullableInt,
  assistsPoints: nullableInt,
  cleanSheets: nullableInt,
  cleanSheetsPoints: nullableInt,
  goalsConceded: nullableInt,
  goalsConcededPoints: nullableInt,
  ownGoals: nullableInt,
  ownGoalsPoints: nullableInt,
  penaltiesSaved: nullableInt,
  penaltiesSavedPoints: nullableInt,
  penaltiesMissed: nullableInt,
  penaltiesMissedPoints: nullableInt,
  yellowCards: nullableInt,
  yellowCardsPoints: nullableInt,
  redCards: nullableInt,
  redCardsPoints: nullableInt,
  saves: nullableInt,
  savesPoints: nullableInt,
});

export const EventLiveExplainsSchema = z.array(EventLiveExplainSchema);

export function validateEventLiveExplain(data: unknown): EventLiveExplain {
  return EventLiveExplainSchema.parse(data);
}

export function validateEventLiveExplains(data: unknown): EventLiveExplains {
  return EventLiveExplainsSchema.parse(data);
}

export function safeValidateEventLiveExplain(data: unknown): EventLiveExplain | null {
  const result = EventLiveExplainSchema.safeParse(data);
  return result.success ? result.data : null;
}

export function totalPoints(explain: EventLiveExplain): number {
  const values = [
    explain.minutesPoints,
    explain.goalsScoredPoints,
    explain.assistsPoints,
    explain.cleanSheetsPoints,
    explain.goalsConcededPoints,
    explain.ownGoalsPoints,
    explain.penaltiesSavedPoints,
    explain.penaltiesMissedPoints,
    explain.yellowCardsPoints,
    explain.redCardsPoints,
    explain.savesPoints,
    explain.bonus,
  ];
  return values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
}

export function hasBonus(explain: EventLiveExplain): boolean {
  return (explain.bonus ?? 0) > 0;
}
