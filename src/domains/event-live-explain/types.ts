import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { EventLiveExplainCreateInputs } from 'src/repositories/event-live-explain/type';
import { EventLiveExplains } from 'src/types/domain/event-live-explain.type';
import { EventId } from 'src/types/domain/event.type';

import { DomainError } from '../../types/error.type';

export interface EventLiveExplainCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface EventLiveExplainCache {
  readonly getEventLiveExplains: (
    eventId: EventId,
  ) => TE.TaskEither<DomainError, EventLiveExplains>;
  readonly setEventLiveExplains: (
    eventLiveExplains: EventLiveExplains,
  ) => TE.TaskEither<DomainError, void>;
}

export interface EventLiveExplainOperations {
  readonly saveEventLiveExplains: (
    eventLiveExplainInputs: EventLiveExplainCreateInputs,
  ) => TE.TaskEither<DomainError, EventLiveExplains>;
  readonly deleteEventLiveExplains: (eventId: EventId) => TE.TaskEither<DomainError, void>;
}
