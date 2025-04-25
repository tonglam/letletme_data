import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { EventFixtureCreateInputs } from 'src/repositories/event-fixture/type';
import { EventFixtures, RawEventFixtures } from 'src/types/domain/event-fixture.type';
import { EventId } from 'src/types/domain/event.type';

import { DomainError } from '../../types/error.type';

export interface EventFixtureCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
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
