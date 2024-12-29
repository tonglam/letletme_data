/**
 * Event Types Module
 *
 * Core type definitions for the Fantasy Premier League event system.
 * Includes branded types, domain models, and data converters.
 */

import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { TaskEither } from 'fp-ts/TaskEither';
import type { BootstrapApi } from '../domains/bootstrap/operations';
import type { EventCache } from '../domains/events/types';
import { parseJsonArray, parseJsonObject } from '../utils/prisma.util';
import type { BaseRepository } from './base.type';
import { Branded, createBrandedType, isApiResponse } from './base.type';
import { APIError, DBError } from './errors.type';

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

/**
 * Raw event data from the API
 */
export interface EventResponse {
  readonly id: number;
  readonly name: string;
  readonly deadline_time: string;
  readonly deadline_time_epoch: number;
  readonly deadline_time_game_offset: number;
  readonly release_time: string | null;
  readonly average_entry_score: number;
  readonly finished: boolean;
  readonly data_checked: boolean;
  readonly highest_score: number;
  readonly highest_scoring_entry: number;
  readonly is_previous: boolean;
  readonly is_current: boolean;
  readonly is_next: boolean;
  readonly cup_leagues_created: boolean;
  readonly h2h_ko_matches_created: boolean;
  readonly ranked_count: number;
  readonly chip_plays: readonly ChipPlay[];
  readonly most_selected: number | null;
  readonly most_transferred_in: number | null;
  readonly most_captained: number | null;
  readonly most_vice_captained: number | null;
  readonly top_element: number | null;
  readonly top_element_info: TopElementInfo | null;
  readonly transfers_made: number;
  readonly can_enter: boolean;
  readonly can_manage: boolean;
  readonly released: boolean;
}

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
  readonly deadlineTime: Date;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: Date | null;
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
  readonly canEnter: boolean;
  readonly canManage: boolean;
  readonly released: boolean;
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
  readonly deadlineTime: Date;
  readonly deadlineTimeEpoch: number;
  readonly deadlineTimeGameOffset: number;
  readonly releaseTime: Date | null;
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
 * Converts API response or database model to domain model
 */
export const toDomainEvent = (data: EventResponse | PrismaEvent): Event => {
  const isEventApiResponse = (d: EventResponse | PrismaEvent): d is EventResponse =>
    isApiResponse(d, 'deadline_time');

  const parseChipPlay = (item: Prisma.JsonObject): ChipPlay => ({
    chip_name: String(item.chip_name || ''),
    num_played: Number(item.num_played || 0),
  });

  const parseTopElement = (obj: Prisma.JsonObject): TopElementInfo | null => {
    if (!obj.id || !obj.points) return null;
    return {
      id: Number(obj.id),
      points: Number(obj.points),
    };
  };

  return {
    id: data.id as EventId,
    name: data.name,
    deadlineTime: isEventApiResponse(data) ? new Date(data.deadline_time) : data.deadlineTime,
    deadlineTimeEpoch: isEventApiResponse(data) ? data.deadline_time_epoch : data.deadlineTimeEpoch,
    deadlineTimeGameOffset: isEventApiResponse(data)
      ? data.deadline_time_game_offset
      : data.deadlineTimeGameOffset,
    releaseTime: isEventApiResponse(data)
      ? data.release_time
        ? new Date(data.release_time)
        : null
      : data.releaseTime,
    averageEntryScore: isEventApiResponse(data) ? data.average_entry_score : data.averageEntryScore,
    finished: data.finished,
    dataChecked: isEventApiResponse(data) ? data.data_checked : data.dataChecked,
    highestScore: isEventApiResponse(data) ? data.highest_score : data.highestScore,
    highestScoringEntry: isEventApiResponse(data)
      ? data.highest_scoring_entry
      : data.highestScoringEntry,
    isPrevious: isEventApiResponse(data) ? data.is_previous : data.isPrevious,
    isCurrent: isEventApiResponse(data) ? data.is_current : data.isCurrent,
    isNext: isEventApiResponse(data) ? data.is_next : data.isNext,
    cupLeaguesCreated: isEventApiResponse(data) ? data.cup_leagues_created : data.cupLeaguesCreated,
    h2hKoMatchesCreated: isEventApiResponse(data)
      ? data.h2h_ko_matches_created
      : data.h2hKoMatchesCreated,
    rankedCount: isEventApiResponse(data) ? data.ranked_count : data.rankedCount,
    chipPlays: isEventApiResponse(data)
      ? data.chip_plays
      : parseJsonArray(data.chipPlays, parseChipPlay),
    mostSelected: isEventApiResponse(data) ? data.most_selected : data.mostSelected,
    mostTransferredIn: isEventApiResponse(data) ? data.most_transferred_in : data.mostTransferredIn,
    mostCaptained: isEventApiResponse(data) ? data.most_captained : data.mostCaptained,
    mostViceCaptained: isEventApiResponse(data) ? data.most_vice_captained : data.mostViceCaptained,
    topElement: isEventApiResponse(data) ? data.top_element : data.topElement,
    topElementInfo: isEventApiResponse(data)
      ? data.top_element_info
      : parseJsonObject(data.topElementInfo, parseTopElement),
    transfersMade: isEventApiResponse(data) ? data.transfers_made : data.transfersMade,
    canEnter: isEventApiResponse(data) ? data.can_enter : false,
    canManage: isEventApiResponse(data) ? data.can_manage : false,
    released: isEventApiResponse(data) ? data.released : false,
  };
};

/**
 * Converts domain model to database model
 */
export const toPrismaEvent = (event: Event): PrismaEventCreate => ({
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
  chipPlays: event.chipPlays as unknown as Prisma.JsonValue,
  mostSelected: event.mostSelected,
  mostTransferredIn: event.mostTransferredIn,
  mostCaptained: event.mostCaptained,
  mostViceCaptained: event.mostViceCaptained,
  topElement: event.topElement,
  topElementInfo: event.topElementInfo as unknown as Prisma.JsonValue,
  transfersMade: event.transfersMade,
});

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
