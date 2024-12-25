import { Prisma, PrismaClient } from '@prisma/client';
import { Either, left, right } from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { z } from 'zod';
import { APIError } from '../infrastructure/api/common/errors';

// ============ Branded Types ============
declare const EventIdBrand: unique symbol;
export type EventId = number & { readonly _brand: typeof EventIdBrand };

// ============ Schemas ============
/**
 * Sub-schemas for nested objects
 */
const TopElementInfoSchema = z.object({
  id: z.number(),
  points: z.number(),
});

const ChipPlaySchema = z.object({
  chip_name: z.string(),
  num_played: z.number(),
});

/**
 * API Response Schema - Validates external API data (snake_case)
 */
const EventResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  deadline_time: z.string(),
  deadline_time_epoch: z.number(),
  deadline_time_game_offset: z.number(),
  release_time: z.string().nullable(),
  average_entry_score: z.number(),
  finished: z.boolean(),
  data_checked: z.boolean(),
  highest_score: z.number().nullable(),
  highest_scoring_entry: z.number().nullable(),
  is_previous: z.boolean(),
  is_current: z.boolean(),
  is_next: z.boolean(),
  cup_leagues_created: z.boolean(),
  h2h_ko_matches_created: z.boolean(),
  ranked_count: z.number(),
  chip_plays: z.array(ChipPlaySchema),
  most_selected: z.number().nullable(),
  most_transferred_in: z.number().nullable(),
  most_captained: z.number().nullable(),
  most_vice_captained: z.number().nullable(),
  top_element: z.number().nullable(),
  top_element_info: TopElementInfoSchema.nullable(),
  transfers_made: z.number(),
});

/**
 * Domain Schema - Internal application model (camelCase)
 */
const EventSchema = z.object({
  id: z.number(),
  name: z.string(),
  deadlineTime: z.date(),
  deadlineTimeEpoch: z.number(),
  deadlineTimeGameOffset: z.number(),
  releaseTime: z.date().nullable(),
  averageEntryScore: z.number(),
  finished: z.boolean(),
  dataChecked: z.boolean(),
  highestScore: z.number().nullable(),
  highestScoringEntry: z.number().nullable(),
  isPrevious: z.boolean(),
  isCurrent: z.boolean(),
  isNext: z.boolean(),
  cupLeaguesCreated: z.boolean(),
  h2hKoMatchesCreated: z.boolean(),
  rankedCount: z.number(),
  chipPlays: z.array(ChipPlaySchema),
  mostSelected: z.number().nullable(),
  mostTransferredIn: z.number().nullable(),
  mostCaptained: z.number().nullable(),
  mostViceCaptained: z.number().nullable(),
  topElement: z.number().nullable(),
  topElementInfo: TopElementInfoSchema.nullable(),
  transfersMade: z.number(),
  createdAt: z.date(),
});

export const EventsResponseSchema = z.array(EventResponseSchema);
export const EventsSchema = z.array(EventSchema);

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export type EventResponse = z.infer<typeof EventResponseSchema>;
export type EventsResponse = z.infer<typeof EventsResponseSchema>;

/**
 * Domain types (camelCase)
 */
export interface Event {
  readonly id: EventId;
  readonly name: string;
  readonly deadlineTime: Date;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: Date | null;
  readonly averageEntryScore: number;
  readonly finished: boolean;
  readonly dataChecked: boolean;
  readonly highestScore: number | null;
  readonly highestScoringEntry: number | null;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly rankedCount: number;
  readonly chipPlays: ChipPlay[];
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
  readonly topElement: number | null;
  readonly topElementInfo: TopElementInfo | null;
  readonly transfersMade: number;
  readonly createdAt: Date;
}

export type Events = z.infer<typeof EventsSchema>;

// ============ Type Transformers ============
/**
 * Transform and validate EventResponse to Event
 */
export const toDomainEvent = (raw: EventResponse): Either<string, Event> => {
  try {
    // Ensure deadlineTime is in UTC
    const deadlineTime = new Date(raw.deadline_time);
    if (isNaN(deadlineTime.getTime())) {
      return left(`Invalid deadline time: ${raw.deadline_time}`);
    }

    const parsed = EventSchema.safeParse({
      id: raw.id,
      name: raw.name,
      deadlineTime, // This will be stored as UTC
      deadlineTimeEpoch: raw.deadline_time_epoch,
      deadlineTimeGameOffset: raw.deadline_time_game_offset,
      releaseTime: raw.release_time ? new Date(raw.release_time) : null,
      averageEntryScore: raw.average_entry_score,
      finished: raw.finished,
      dataChecked: raw.data_checked,
      highestScore: raw.highest_score,
      highestScoringEntry: raw.highest_scoring_entry,
      isPrevious: raw.is_previous,
      isCurrent: raw.is_current,
      isNext: raw.is_next,
      cupLeaguesCreated: raw.cup_leagues_created,
      h2hKoMatchesCreated: raw.h2h_ko_matches_created,
      rankedCount: raw.ranked_count,
      chipPlays: raw.chip_plays,
      mostSelected: raw.most_selected,
      mostTransferredIn: raw.most_transferred_in,
      mostCaptained: raw.most_captained,
      mostViceCaptained: raw.most_vice_captained,
      topElement: raw.top_element,
      topElementInfo: raw.top_element_info,
      transfersMade: raw.transfers_made,
    });

    if (!parsed.success) {
      return left(`Invalid event domain model: ${parsed.error.message}`);
    }

    const result = {
      ...parsed.data,
      id: parsed.data.id as EventId,
    };

    return right(result);
  } catch (error) {
    return left(
      `Failed to transform event data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

// ============ Type Guards & Validation ============
export const isEventId = (id: unknown): id is EventId =>
  typeof id === 'number' && id > 0 && Number.isInteger(id);

export const validateEventId = (id: number): Either<string, EventId> =>
  isEventId(id) ? right(id as EventId) : left(`Invalid event ID: ${id}`);

export const isValidEvent = (event: Event): boolean =>
  isEventId(event.id) &&
  typeof event.name === 'string' &&
  event.name.length > 0 &&
  event.deadlineTime instanceof Date &&
  typeof event.deadlineTimeEpoch === 'number' &&
  typeof event.averageEntryScore === 'number' &&
  typeof event.finished === 'boolean';

// ============ Persistence Types ============
export interface ChipPlay {
  readonly chip_name: string;
  readonly num_played: number;
}

export interface TopElementInfo {
  readonly id: number;
  readonly points: number;
}

export interface PrismaEvent {
  readonly id: number;
  readonly name: string;
  readonly deadlineTime: Date;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: Date | null;
  readonly averageEntryScore: number;
  readonly finished: boolean;
  readonly dataChecked: boolean;
  readonly highestScore: number | null;
  readonly highestScoringEntry: number | null;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly rankedCount: number;
  readonly chipPlays: Prisma.JsonValue | Prisma.InputJsonValue;
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
  readonly topElement: number | null;
  readonly topElementInfo: Prisma.JsonValue | Prisma.InputJsonValue;
  readonly transfersMade: number;
  readonly createdAt: Date;
}

export type PrismaEventCreate = {
  readonly id: number;
  readonly name: string;
  readonly deadlineTime: Date;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: Date | null;
  readonly averageEntryScore: number;
  readonly finished: boolean;
  readonly dataChecked: boolean;
  readonly highestScore: number | null;
  readonly highestScoringEntry: number | null;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly rankedCount: number;
  readonly chipPlays: Prisma.InputJsonValue;
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
  readonly topElement: number | null;
  readonly topElementInfo: Prisma.InputJsonValue;
  readonly transfersMade: number;
  readonly createdAt: Date;
};

export type PrismaEventUpdate = {
  readonly name?: string | Prisma.StringFieldUpdateOperationsInput;
  readonly deadlineTime?: Date | Prisma.DateTimeFieldUpdateOperationsInput;
  readonly deadlineTimeEpoch?: number | Prisma.IntFieldUpdateOperationsInput;
  readonly deadlineTimeGameOffset?: number | Prisma.IntFieldUpdateOperationsInput;
  readonly releaseTime?: Date | Prisma.NullableDateTimeFieldUpdateOperationsInput | null;
  readonly averageEntryScore?: number | Prisma.IntFieldUpdateOperationsInput;
  readonly finished?: boolean | Prisma.BoolFieldUpdateOperationsInput;
  readonly dataChecked?: boolean | Prisma.BoolFieldUpdateOperationsInput;
  readonly highestScore?: number | Prisma.NullableIntFieldUpdateOperationsInput | null;
  readonly highestScoringEntry?: number | Prisma.NullableIntFieldUpdateOperationsInput | null;
  readonly isPrevious?: boolean | Prisma.BoolFieldUpdateOperationsInput;
  readonly isCurrent?: boolean | Prisma.BoolFieldUpdateOperationsInput;
  readonly isNext?: boolean | Prisma.BoolFieldUpdateOperationsInput;
  readonly cupLeaguesCreated?: boolean | Prisma.BoolFieldUpdateOperationsInput;
  readonly h2hKoMatchesCreated?: boolean | Prisma.BoolFieldUpdateOperationsInput;
  readonly rankedCount?: number | Prisma.IntFieldUpdateOperationsInput;
  readonly chipPlays?: Prisma.InputJsonValue;
  readonly mostSelected?: number | Prisma.NullableIntFieldUpdateOperationsInput | null;
  readonly mostTransferredIn?: number | Prisma.NullableIntFieldUpdateOperationsInput | null;
  readonly mostCaptained?: number | Prisma.NullableIntFieldUpdateOperationsInput | null;
  readonly mostViceCaptained?: number | Prisma.NullableIntFieldUpdateOperationsInput | null;
  readonly topElement?: number | Prisma.NullableIntFieldUpdateOperationsInput | null;
  readonly topElementInfo?: Prisma.InputJsonValue;
  readonly transfersMade?: number | Prisma.IntFieldUpdateOperationsInput;
  readonly createdAt?: Date | Prisma.DateTimeFieldUpdateOperationsInput;
};

// ============ Repository Interface ============
export interface EventRepository {
  prisma: PrismaClient;
  findById(id: EventId): TE.TaskEither<APIError, PrismaEvent | null>;
  findAll(): TE.TaskEither<APIError, PrismaEvent[]>;
  save(data: PrismaEventCreate): TE.TaskEither<APIError, PrismaEvent>;
  saveBatch(data: PrismaEventCreate[]): TE.TaskEither<APIError, PrismaEvent[]>;
  update(id: EventId, data: PrismaEventUpdate): TE.TaskEither<APIError, PrismaEvent>;
  deleteAll(): TE.TaskEither<APIError, void>;
  findByIds(ids: EventId[]): TE.TaskEither<APIError, PrismaEvent[]>;
  deleteByIds(ids: EventId[]): TE.TaskEither<APIError, void>;
  findCurrent(): TE.TaskEither<APIError, PrismaEvent | null>;
  findNext(): TE.TaskEither<APIError, PrismaEvent | null>;
}
