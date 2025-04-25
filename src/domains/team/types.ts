import * as TE from 'fp-ts/TaskEither';
import { CachePrefix, DefaultTTL } from 'src/configs/cache/cache.config';
import { Teams } from 'src/types/domain/team.type';
import { DomainError } from 'src/types/error.type';

import { TeamCreateInputs } from '../../repositories/team/types';

export interface TeamCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface TeamCache {
  readonly getAllTeams: () => TE.TaskEither<DomainError, Teams>;
  readonly setAllTeams: (teams: Teams) => TE.TaskEither<DomainError, void>;
}

export interface TeamOperations {
  readonly saveTeams: (teamInputs: TeamCreateInputs) => TE.TaskEither<DomainError, Teams>;
  readonly deleteAllTeams: () => TE.TaskEither<DomainError, void>;
}
