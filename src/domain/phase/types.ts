import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import * as TE from 'fp-ts/TaskEither';
import { Phases } from 'types/domain/phase.type';
import { CacheError } from 'types/error.type';

export interface PhaseCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
  ttlSeconds: (typeof DefaultTTL)[keyof typeof DefaultTTL];
}

export interface PhaseCache {
  readonly getAllPhases: () => TE.TaskEither<CacheError, Phases>;
  readonly setAllPhases: (phases: Phases) => TE.TaskEither<CacheError, void>;
}
