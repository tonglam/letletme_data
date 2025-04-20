import * as TE from 'fp-ts/TaskEither';
import { Event, Events } from 'src/types/domain/event.type';

import { DomainError } from '../../types/error.type';

import type { EventCreateInputs } from '../../repositories/event/type';

export interface EventCacheConfig {
  readonly keyPrefix: string;
  readonly season: string;
}

export interface EventCache {
  readonly getCurrentEvent: () => TE.TaskEither<DomainError, Event>;
  readonly setCurrentEvent: (event: Event) => TE.TaskEither<DomainError, void>;
  readonly getAllEvents: () => TE.TaskEither<DomainError, Events>;
  readonly setAllEvents: (events: Events) => TE.TaskEither<DomainError, void>;
  readonly deleteAllEvents: () => TE.TaskEither<DomainError, void>;
}

export interface EventOperations {
  readonly saveEvents: (events: EventCreateInputs) => TE.TaskEither<DomainError, Events>;
  readonly deleteAllEvents: () => TE.TaskEither<DomainError, void>;
}
