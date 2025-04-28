import { CachePrefix, DefaultTTL } from 'configs/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { EventFixtureCreateInputs } from 'repositories/event-fixture/types';
import { EventFixtures, RawEventFixtures } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { DomainError } from 'types/error.type';

export interface EventFixtureCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface EventFixtureCache {
  readonly getEventFixtures: (eventId: EventId) => TE.TaskEither<DomainError, EventFixtures>;
  readonly getAllEventFixtures: () => TE.TaskEither<DomainError, EventFixtures>;
  readonly setEventFixtures: (eventFixtures: EventFixtures) => TE.TaskEither<DomainError, void>;
}

export interface EventFixtureOperations {
  readonly saveEventFixtures: (
    eventFixtureInputs: EventFixtureCreateInputs,
  ) => TE.TaskEither<DomainError, RawEventFixtures>;
  readonly deleteEventFixtures: (eventId: EventId) => TE.TaskEither<DomainError, void>;
}
