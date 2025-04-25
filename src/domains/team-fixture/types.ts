import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { TeamFixtures } from 'src/types/domain/team-fixture.type';
import { TeamId } from 'src/types/domain/team.type';

import { DomainError } from '../../types/error.type';

export interface TeamFixtureCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface TeamFixtureCache {
  readonly getFixturesByTeamId: (teamId: TeamId) => TE.TaskEither<DomainError, TeamFixtures>;
  readonly setFixturesByTeamId: (teamFixtures: TeamFixtures) => TE.TaskEither<DomainError, void>;
}
