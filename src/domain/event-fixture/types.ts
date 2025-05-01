import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { EventFixtures } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { CacheError } from 'types/error.type';

export interface EventFixtureCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface EventFixtureCache {
  readonly getEventFixtures: (eventId: EventId) => TE.TaskEither<CacheError, EventFixtures>;
  readonly getAllEventFixtures: () => TE.TaskEither<CacheError, EventFixtures>;
  readonly setEventFixtures: (eventFixtures: EventFixtures) => TE.TaskEither<CacheError, void>;
}
