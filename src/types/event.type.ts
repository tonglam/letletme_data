/**
 * Event Types Module
 *
 * Core type definitions for the Fantasy Premier League event system.
 * Includes branded types, domain models, and data converters.
 */

import { Prisma } from '@prisma/client';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { TaskEither } from 'fp-ts/TaskEither';
import { z } from 'zod';
import type { BootstrapApi } from '../domain/bootstrap/types';
import type { EventCache } from '../domain/event/types';
import type { BaseRepository } from './base.type';
import { Branded, createBrandedType, isApiResponse } from './base.type';
import { APIError, DBError } from './error.type';

/**
 * Branded type for Event ID ensuring type safety
 */
export type EventId = Branded<number, 'EventId'>;

/**
 * Creates a branded EventId with validation
 */
export const createEventId = createBrandedType<number, 'EventId'>(
  'EventId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

/**
 * Validates and converts a value to EventId
 */
export const validateEventId = (value: unknown): E.Either<string, EventId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid event ID: must be a positive integer',
    ),
    E.map((v) => v as EventId),
  );

/**
 * Information about the top performing element in an event
 */
export interface TopElementInfo {
  readonly id: number;
  readonly points: number;
}

/**
 * Information about chip usage in an event
 */
export interface ChipPlay {
  readonly chip_name: string;
  readonly num_played: number;
}

// Zod schemas for nested types
export const TopElementInfoSchema = z.object({
  id: z.number(),
  points: z.number(),
});

export const ChipPlaySchema = z.object({
  chip_name: z.string(),
  num_played: z.number(),
});

/**
 * Schema for validating event response data from the FPL API
 * Only strictly validates fields required by Prisma model
 */
export const EventResponseSchema = z
  .object({
    // Required fields (must exist in API response)
    id: z.number(),
    name: z.string(),
    deadline_time: z.string(),
    deadline_time_epoch: z.number(),
    finished: z.boolean(),
    is_previous: z.boolean(),
    is_current: z.boolean(),
    is_next: z.boolean(),

    // Fields with default values (required in Prisma but can have defaults)
    deadline_time_game_offset: z.number().default(0),
    average_entry_score: z.number().default(0),
    data_checked: z.boolean().default(false),
    highest_score: z.number().nullable().default(0),
    highest_scoring_entry: z.number().nullable().default(0),
    cup_leagues_created: z.boolean().default(false),
    h2h_ko_matches_created: z.boolean().default(false),
    transfers_made: z.number().default(0),

    // Optional fields (nullable in Prisma)
    release_time: z.string().nullable().optional(),
    chip_plays: z.array(ChipPlaySchema).default([]),
    most_selected: z.number().nullable().optional(),
    most_transferred_in: z.number().nullable().optional(),
    most_captained: z.number().nullable().optional(),
    most_vice_captained: z.number().nullable().optional(),
    top_element: z.number().nullable().optional(),
    top_element_info: TopElementInfoSchema.nullable().optional(),

    // Other API fields that we don't store
    release_time_epoch: z.number().nullable().optional(),
    release_time_game_offset: z.number().nullable().optional(),
    chip_plays_processed: z.boolean().optional(),
    released: z.boolean().optional(),
  })
  .passthrough();

/**
 * Type for event response data from the FPL API
 * Inferred from schema to allow additional fields
 */
export type EventResponse = z.infer<typeof EventResponseSchema>;

/**
 * Array of event responses
 */
export type EventsResponse = readonly EventResponse[];

/**
 * Core event domain model
 */
export interface Event {
  readonly id: EventId;
  readonly name: string;
  readonly deadlineTime: string;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: string | null;
  readonly averageEntryScore: number;
  readonly finished: boolean;
  readonly dataChecked: boolean;
  readonly highestScore: number;
  readonly highestScoringEntry: number;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly rankedCount: number;
  readonly chipPlays: readonly ChipPlay[];
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
  readonly topElement: number | null;
  readonly topElementInfo: TopElementInfo | null;
  readonly transfersMade: number;
}

/**
 * Array of event domain models
 */
export type Events = readonly Event[];

/**
 * Event repository interface
 * Extends base repository with event-specific operations
 */
export interface EventRepository extends BaseRepository<PrismaEvent, PrismaEventCreate, EventId> {
  readonly findCurrent: () => TaskEither<DBError, PrismaEvent | null>;
  readonly findNext: () => TaskEither<DBError, PrismaEvent | null>;
  readonly findByIds: (ids: EventId[]) => TaskEither<DBError, PrismaEvent[]>;
  readonly update: (id: EventId, event: PrismaEventUpdate) => TaskEither<DBError, PrismaEvent>;
}

/**
 * Prisma database model for Event
 */
export interface PrismaEvent {
  readonly id: number;
  readonly name: string;
  readonly deadlineTime: string;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: string | null;
  readonly averageEntryScore: number;
  readonly finished: boolean;
  readonly dataChecked: boolean;
  readonly highestScore: number;
  readonly highestScoringEntry: number;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly rankedCount: number;
  readonly chipPlays: Prisma.JsonValue | null;
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
  readonly topElement: number | null;
  readonly topElementInfo: Prisma.JsonValue | null;
  readonly transfersMade: number;
  readonly createdAt: Date;
}

/**
 * Prisma event creation type
 */
export type PrismaEventCreate = Omit<PrismaEvent, 'createdAt'>;

/**
 * Prisma event update type
 */
export type PrismaEventUpdate = Omit<PrismaEvent, 'createdAt'>;

/**
 * Type guard for API response
 */
const isEventApiResponse = (d: EventResponse | PrismaEvent): d is EventResponse =>
  isApiResponse(d, 'deadline_time');

/**
 * Transform functions for nested types
 */
const transformChipPlay = (item: Prisma.JsonObject): E.Either<string, ChipPlay> =>
  pipe(
    E.Do,
    E.bind('chip_name', () => E.right(String(item.chip_name || ''))),
    E.bind('num_played', () => E.right(Number(item.num_played || 0))),
    E.map(({ chip_name, num_played }) => ({
      chip_name,
      num_played,
    })),
  );

const transformTopElement = (obj: Prisma.JsonObject): E.Either<string, TopElementInfo | null> => {
  const id = obj.id;
  const points = obj.points;

  if (typeof id !== 'number' || typeof points !== 'number') {
    return E.right(null);
  }

  return E.right({ id, points });
};

const transformChipPlays = (
  data: Prisma.JsonValue | null,
): E.Either<string, readonly ChipPlay[]> => {
  if (!data) return E.right([]);

  try {
    const parsed = JSON.parse(JSON.stringify(data));
    if (!Array.isArray(parsed)) return E.right([]);

    return pipe(parsed as Prisma.JsonObject[], A.traverse(E.Applicative)(transformChipPlay));
  } catch {
    return E.right([]);
  }
};

const transformTopElementInfo = (
  data: Prisma.JsonValue | null,
): E.Either<string, TopElementInfo | null> => {
  if (!data) return E.right(null);

  try {
    const parsed = JSON.parse(JSON.stringify(data)) as Prisma.JsonObject;
    const result = transformTopElement(parsed);
    if (E.isLeft(result)) return E.right(null);
    return result;
  } catch {
    return E.right(null);
  }
};

/**
 * Converts API response or database model to domain model
 */
export const toDomainEvent = (data: EventResponse | PrismaEvent): E.Either<string, Event> =>
  pipe(
    E.Do,
    E.bind('id', () => validateEventId(data.id)),
    E.bind('chipPlays', () =>
      isEventApiResponse(data) ? E.right(data.chip_plays) : transformChipPlays(data.chipPlays),
    ),
    E.bind('topElementInfo', () =>
      isEventApiResponse(data)
        ? E.right(data.top_element_info ?? null)
        : transformTopElementInfo(data.topElementInfo),
    ),
    E.map(
      (transformed): Event => ({
        id: transformed.id,
        name: data.name,
        deadlineTime: isEventApiResponse(data) ? data.deadline_time : data.deadlineTime,
        deadlineTimeEpoch: isEventApiResponse(data)
          ? data.deadline_time_epoch
          : data.deadlineTimeEpoch,
        deadlineTimeGameOffset: isEventApiResponse(data)
          ? data.deadline_time_game_offset ?? 0
          : data.deadlineTimeGameOffset,
        releaseTime: isEventApiResponse(data) ? data.release_time ?? null : data.releaseTime,
        averageEntryScore: isEventApiResponse(data)
          ? data.average_entry_score ?? 0
          : data.averageEntryScore,
        finished: data.finished,
        dataChecked: isEventApiResponse(data) ? data.data_checked ?? false : data.dataChecked,
        highestScore: isEventApiResponse(data) ? data.highest_score ?? 0 : data.highestScore,
        highestScoringEntry: isEventApiResponse(data)
          ? data.highest_scoring_entry ?? 0
          : data.highestScoringEntry,
        isPrevious: isEventApiResponse(data) ? data.is_previous : data.isPrevious,
        isCurrent: isEventApiResponse(data) ? data.is_current : data.isCurrent,
        isNext: isEventApiResponse(data) ? data.is_next : data.isNext,
        cupLeaguesCreated: isEventApiResponse(data)
          ? data.cup_leagues_created ?? false
          : data.cupLeaguesCreated,
        h2hKoMatchesCreated: isEventApiResponse(data)
          ? data.h2h_ko_matches_created ?? false
          : data.h2hKoMatchesCreated,
        rankedCount: isEventApiResponse(data) ? 0 : data.rankedCount,
        chipPlays: transformed.chipPlays,
        mostSelected: isEventApiResponse(data) ? data.most_selected ?? null : data.mostSelected,
        mostTransferredIn: isEventApiResponse(data)
          ? data.most_transferred_in ?? null
          : data.mostTransferredIn,
        mostCaptained: isEventApiResponse(data) ? data.most_captained ?? null : data.mostCaptained,
        mostViceCaptained: isEventApiResponse(data)
          ? data.most_vice_captained ?? null
          : data.mostViceCaptained,
        topElement: isEventApiResponse(data) ? data.top_element ?? null : data.topElement,
        topElementInfo: transformed.topElementInfo,
        transfersMade: isEventApiResponse(data) ? data.transfers_made ?? 0 : data.transfersMade,
      }),
    ),
  );

/**
 * Converts domain model to database model with validation
 */
export const toPrismaEvent = (event: Event): E.Either<string, PrismaEventCreate> =>
  pipe(
    E.Do,
    E.bind('chipPlays', () =>
      E.right(event.chipPlays.length > 0 ? JSON.parse(JSON.stringify(event.chipPlays)) : undefined),
    ),
    E.bind('topElementInfo', () =>
      E.right(event.topElementInfo ? JSON.parse(JSON.stringify(event.topElementInfo)) : undefined),
    ),
    E.map(
      (transformed): PrismaEventCreate => ({
        id: Number(event.id),
        name: event.name,
        deadlineTime: event.deadlineTime,
        deadlineTimeEpoch: event.deadlineTimeEpoch,
        deadlineTimeGameOffset: event.deadlineTimeGameOffset,
        releaseTime: event.releaseTime,
        averageEntryScore: event.averageEntryScore,
        finished: event.finished,
        dataChecked: event.dataChecked,
        highestScore: event.highestScore,
        highestScoringEntry: event.highestScoringEntry,
        isPrevious: event.isPrevious,
        isCurrent: event.isCurrent,
        isNext: event.isNext,
        cupLeaguesCreated: event.cupLeaguesCreated,
        h2hKoMatchesCreated: event.h2hKoMatchesCreated,
        rankedCount: event.rankedCount,
        chipPlays: transformed.chipPlays,
        mostSelected: event.mostSelected,
        mostTransferredIn: event.mostTransferredIn,
        mostCaptained: event.mostCaptained,
        mostViceCaptained: event.mostViceCaptained,
        topElement: event.topElement,
        topElementInfo: transformed.topElementInfo,
        transfersMade: event.transfersMade,
      }),
    ),
  );

/**
 * Helper functions for array transformations
 */
export const convertPrismaEvents = (events: PrismaEvent[]): TE.TaskEither<string, Events> =>
  pipe(
    events,
    A.traverse(E.Applicative)(toDomainEvent),
    TE.fromEither,
    TE.map((events) => events as Events),
  );

export const convertPrismaEvent = (
  event: PrismaEvent | null,
): TE.TaskEither<string, Event | null> =>
  pipe(
    O.fromNullable(event),
    O.traverse(E.Applicative)(toDomainEvent),
    E.map(O.toNullable),
    TE.fromEither,
  );

/**
 * Service interface for Event operations
 */
export interface EventService {
  readonly warmUp: () => TE.TaskEither<APIError, void>;
  readonly getEvents: () => TE.TaskEither<APIError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<APIError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<APIError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<APIError, Event | null>;
}

/**
 * Dependencies required by the EventService
 */
export interface EventServiceDependencies {
  bootstrapApi: BootstrapApi;
  eventCache: EventCache;
  eventRepository: EventRepository;
}