import * as TE from 'fp-ts/TaskEither';
import { CachePrefix, DefaultTTL } from 'src/configs/cache/cache.config';
import { Event, Events } from 'src/types/domain/event.type';

import { DomainError } from '../../types/error.type';

import type { EventCreateInputs } from '../../repositories/event/types';
export interface EventCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface EventCache {
  readonly getCurrentEvent: () => TE.TaskEither<DomainError, Event>;
  readonly setCurrentEvent: (event: Event) => TE.TaskEither<DomainError, void>;
  readonly getAllEvents: () => TE.TaskEither<DomainError, Events>;
  readonly setAllEvents: (events: Events) => TE.TaskEither<DomainError, void>;
}

export interface EventOperations {
  readonly saveEvents: (eventInputs: EventCreateInputs) => TE.TaskEither<DomainError, Events>;
  readonly deleteAllEvents: () => TE.TaskEither<DomainError, void>;
}
