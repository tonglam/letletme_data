import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { EventLiveCreateInputs } from 'src/repositories/event-live/types';
import { EventLives, RawEventLives } from 'src/types/domain/event-live.type';
import { EventId } from 'src/types/domain/event.type';

import { DomainError } from '../../types/error.type';

export interface EventLiveCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface EventLiveCache {
  readonly getEventLives: (eventId: EventId) => TE.TaskEither<DomainError, EventLives>;
  readonly setEventLives: (eventLives: EventLives) => TE.TaskEither<DomainError, void>;
}

export interface EventLiveOperations {
  readonly saveEventLives: (
    eventLiveInputs: EventLiveCreateInputs,
  ) => TE.TaskEither<DomainError, RawEventLives>;
  readonly deleteEventLives: (eventId: EventId) => TE.TaskEither<DomainError, void>;
}
