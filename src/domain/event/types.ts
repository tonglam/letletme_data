import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { Event, EventId, Events } from 'types/domain/event.type';
import { CacheError } from 'types/error.type';

export { Event, Events };

export interface EventCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface EventCache {
  readonly getCurrentEvent: () => TE.TaskEither<CacheError, Event>;
  readonly getLastEvent: () => TE.TaskEither<CacheError, Event>;
  readonly getNextEvent: () => TE.TaskEither<CacheError, Event>;
  readonly setCurrentEvent: (event: Event) => TE.TaskEither<CacheError, void>;
  readonly getEvent: (id: EventId) => TE.TaskEither<CacheError, Event>;
  readonly getAllEvents: () => TE.TaskEither<CacheError, Events>;
  readonly setAllEvents: (events: Events) => TE.TaskEither<CacheError, void>;
}
