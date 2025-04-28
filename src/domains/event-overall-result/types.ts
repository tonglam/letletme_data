import * as TE from 'fp-ts/TaskEither';
import { DefaultTTL } from 'src/configs/cache/cache.config';
import { CachePrefix } from 'src/configs/cache/cache.config';
import {
  EventOverallResult,
  EventOverallResults,
} from 'src/types/domain/event-overall-result.type';
import { EventId } from 'src/types/domain/event.type';

import { DomainError } from '../../types/error.type';

export interface EventOverallResultCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface EventOverallResultCache {
  readonly getEventOverallResult: (
    eventId: EventId,
  ) => TE.TaskEither<DomainError, EventOverallResult>;
  readonly getAllEventOverallResults: () => TE.TaskEither<DomainError, EventOverallResults>;
  readonly setAllEventOverallResults: (
    eventOverallResults: EventOverallResults,
  ) => TE.TaskEither<DomainError, void>;
}
