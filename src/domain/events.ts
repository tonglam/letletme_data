import { z } from 'zod';

import type { Event } from '../types';

export type { Event };

export const EventSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  deadlineTime: z.date().nullable(),
  averageEntryScore: z.number().nullable(),
  finished: z.boolean(),
  dataChecked: z.boolean(),
  highestScoringEntry: z.number().nullable(),
  deadlineTimeEpoch: z.number().nullable(),
  deadlineTimeGameOffset: z.number().nullable(),
  highestScore: z.number().nullable(),
  isPrevious: z.boolean(),
  isCurrent: z.boolean(),
  isNext: z.boolean(),
  cupLeagueCreate: z.boolean(),
  h2hKoMatchesCreated: z.boolean(),
  chipPlays: z.array(z.object({ chipName: z.string(), numberPlayed: z.number() })),
  mostSelected: z.number().nullable(),
  mostTransferredIn: z.number().nullable(),
  topElement: z.number().nullable(),
  topElementInfo: z.object({ element: z.number(), points: z.number() }).nullable(),
  transfersMade: z.number().nullable(),
  mostCaptained: z.number().nullable(),
  mostViceCaptained: z.number().nullable(),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
});

export function validateEvent(data: unknown): Event {
  return EventSchema.parse(data) as Event;
}

export function safeValidateEvent(data: unknown): Event | null {
  const result = EventSchema.safeParse(data);
  return result.success ? (result.data as Event) : null;
}

export const isCurrent = (event: Event): boolean => event.isCurrent;
export const isNext = (event: Event): boolean => event.isNext;
export const isPrevious = (event: Event): boolean => event.isPrevious;
export const isFinished = (event: Event): boolean => event.finished;
export const isDataChecked = (event: Event): boolean => event.dataChecked;
