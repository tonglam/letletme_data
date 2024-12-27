import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { parseJsonArray, parseJsonObject } from '../infrastructure/db/utils';
import { APIError } from '../infrastructure/http/common/errors';
import { BaseRepository, Branded, createBrandedType, isApiResponse } from './base.type';

// ============ Branded Types ============
export type EventId = Branded<number, 'EventId'>;

export const EventId = createBrandedType<number, 'EventId'>(
  'EventId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

export const validateEventId = (value: unknown): E.Either<string, EventId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid event ID: must be a positive integer',
    ),
    E.map((v) => v as EventId),
  );

// ============ Types ============
/**
 * API Response types (snake_case)
 */
export interface TopElementInfo {
  readonly id: number;
  readonly points: number;
}

export interface ChipPlay {
  readonly chip_name: string;
  readonly num_played: number;
}

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

export type EventsResponse = readonly EventResponse[];

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

export type Events = readonly Event[];

// ============ Repository Interface ============
export interface EventRepository extends BaseRepository<PrismaEvent, PrismaEventCreate, EventId> {
  findCurrent(): TE.TaskEither<APIError, PrismaEvent | null>;
  findNext(): TE.TaskEither<APIError, PrismaEvent | null>;
}

// ============ Persistence Types ============
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

export type PrismaEventCreate = Omit<PrismaEvent, 'createdAt'>;
export type PrismaEventUpdate = Partial<Omit<PrismaEvent, 'id' | 'createdAt'>>;

// ============ Converters ============
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

export const convertPrismaEvents = (
  events: readonly PrismaEvent[],
): TE.TaskEither<APIError, Events> =>
  pipe(
    events,
    TE.right,
    TE.map((values) => values.map(toDomainEvent)),
  );

export const convertPrismaEvent = (
  event: PrismaEvent | null,
): TE.TaskEither<APIError, Event | null> => TE.right(event ? toDomainEvent(event) : null);
