import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { TeamFixtures } from 'types/domain/team-fixture.type';
import { TeamId } from 'types/domain/team.type';
import { DomainError } from 'types/error.type';

export interface TeamFixtureCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface TeamFixtureCache {
  readonly getFixturesByTeamId: (teamId: TeamId) => TE.TaskEither<DomainError, TeamFixtures>;
  readonly setFixturesByTeamId: (teamFixtures: TeamFixtures) => TE.TaskEither<DomainError, void>;
}
