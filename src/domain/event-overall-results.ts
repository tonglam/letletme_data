import { z } from 'zod';

export interface EventChipData {
  readonly chipName: string;
  readonly numberPlayed: number;
}

export interface EventTopElementData {
  readonly element: number;
  readonly points: number;
}

export interface EventOverallResultData {
  readonly event: number;
  readonly averageEntryScore: number | null;
  readonly finished: boolean;
  readonly highestScoringEntry: number | null;
  readonly highestScore: number | null;
  readonly chipPlays: EventChipData[];
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly topElementInfo: EventTopElementData | null;
  readonly transfersMade: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
}

export type EventOverallResultDataList = readonly EventOverallResultData[];

export const EventChipDataSchema = z.object({
  chipName: z.string().min(1),
  numberPlayed: z.number().int().min(0),
});

export const EventTopElementDataSchema = z.object({
  element: z.number().int().positive(),
  points: z.number().int(),
});

export const EventOverallResultDataSchema = z.object({
  event: z.number().int().positive(),
  averageEntryScore: z.number().nullable(),
  finished: z.boolean(),
  highestScoringEntry: z.number().int().nullable(),
  highestScore: z.number().int().nullable(),
  chipPlays: z.array(EventChipDataSchema),
  mostSelected: z.number().int().nullable(),
  mostTransferredIn: z.number().int().nullable(),
  topElementInfo: EventTopElementDataSchema.nullable(),
  transfersMade: z.number().int().nullable(),
  mostCaptained: z.number().int().nullable(),
  mostViceCaptained: z.number().int().nullable(),
});

export const EventOverallResultDataListSchema = z.array(EventOverallResultDataSchema);

export function validateEventOverallResultData(data: unknown): EventOverallResultData {
  return EventOverallResultDataSchema.parse(data);
}

export function validateEventOverallResultDataList(data: unknown): EventOverallResultDataList {
  return EventOverallResultDataListSchema.parse(data);
}

export function safeValidateEventOverallResultData(data: unknown): EventOverallResultData | null {
  const result = EventOverallResultDataSchema.safeParse(data);
  return result.success ? result.data : null;
}

export function isFinished(result: EventOverallResultData): boolean {
  return result.finished;
}

export function topChip(result: EventOverallResultData): EventChipData | null {
  if (result.chipPlays.length === 0) return null;
  return result.chipPlays.reduce((max, cp) => (cp.numberPlayed > max.numberPlayed ? cp : max));
}
