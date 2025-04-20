import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { Teams } from 'src/types/domain/team.type';
import { DomainError } from 'src/types/error.type';

import { TeamCreateInput } from '../../repositories/team/type';

export interface TeamCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface TeamCache {
  readonly getAllTeams: () => TE.TaskEither<DomainError, Teams>;
  readonly setAllTeams: (teams: Teams) => TE.TaskEither<DomainError, void>;
  readonly deleteAllTeams: () => TE.TaskEither<DomainError, void>;
}

export interface TeamOperations {
  readonly saveTeams: (teams: readonly TeamCreateInput[]) => TE.TaskEither<DomainError, Teams>;
  readonly deleteAllTeams: () => TE.TaskEither<DomainError, void>;
}
