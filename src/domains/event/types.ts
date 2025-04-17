import * as TE from 'fp-ts/TaskEither';
import { Event, EventId, Events } from 'src/types/domain/event.type';
import type { PrismaEventCreate } from '../../repositories/event/type';
import { DBError, DomainError } from '../../types/error.type';

// ============ Repository Types ============

export interface EventRepository {
  readonly findAll: () => TE.TaskEither<DBError, Events>;
  readonly findById: (id: EventId) => TE.TaskEither<DBError, Event | null>;
  readonly findCurrent: () => TE.TaskEither<DBError, Event | null>;
  readonly findNext: () => TE.TaskEither<DBError, Event | null>;
  readonly saveBatch: (events: readonly PrismaEventCreate[]) => TE.TaskEither<DBError, Events>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}

// ============ Cache Types ============

export interface EventCacheConfig {
  readonly keyPrefix: string;
  readonly season: string;
}

export interface EventCache {
  readonly getEvent: (id: EventId) => TE.TaskEither<DomainError, Event | null>;
  readonly getAllEvents: () => TE.TaskEither<DomainError, Events | null>;
  readonly setAllEvents: (events: Events) => TE.TaskEither<DomainError, void>;
  readonly deleteAllEvents: () => TE.TaskEither<DomainError, void>;
}

// ============ Operations Types ============

export interface EventOperations {
  readonly getAllEvents: () => TE.TaskEither<DomainError, Events>;
  readonly getEventById: (id: EventId) => TE.TaskEither<DomainError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<DomainError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<DomainError, Event | null>;
  readonly saveEvents: (events: readonly PrismaEventCreate[]) => TE.TaskEither<DomainError, Events>;
  readonly deleteAllEvents: () => TE.TaskEither<DomainError, void>;
}
