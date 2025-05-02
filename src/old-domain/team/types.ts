import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { Teams } from 'types/domain/team.type';
import { CacheError } from 'types/error.type';

export interface TeamCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface TeamCache {
  readonly getAllTeams: () => TE.TaskEither<CacheError, Teams>;
  readonly setAllTeams: (teams: Teams) => TE.TaskEither<CacheError, void>;
}
