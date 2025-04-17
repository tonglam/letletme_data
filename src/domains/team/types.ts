import * as TE from 'fp-ts/TaskEither';
import { CachePrefix } from 'src/configs/cache/cache.config';
import { Team, TeamId, Teams } from 'src/types/domain/team.type';
import { DBError, DomainError } from 'src/types/error.type';
import { PrismaTeamCreate } from '../../repositories/team/type';

// ============ Repository Types============

export interface TeamRepository {
  readonly findAll: () => TE.TaskEither<DBError, Teams>;
  readonly findById: (id: TeamId) => TE.TaskEither<DBError, Team | null>;
  readonly saveBatch: (data: readonly PrismaTeamCreate[]) => TE.TaskEither<DBError, Teams>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}

// ============ Cache Types ============

export interface TeamCacheConfig {
  readonly keyPrefix: (typeof CachePrefix)[keyof typeof CachePrefix];
  readonly season: string;
}

export interface TeamCache {
  readonly getTeam: (id: TeamId) => TE.TaskEither<DomainError, Team | null>;
  readonly getAllTeams: () => TE.TaskEither<DomainError, Teams | null>;
  readonly setAllTeams: (teams: Teams) => TE.TaskEither<DomainError, void>;
  readonly deleteAllTeams: () => TE.TaskEither<DomainError, void>;
}

// ============ Operations Types ============

export interface TeamOperations {
  readonly getAllTeams: () => TE.TaskEither<DomainError, Teams>;
  readonly getTeamById: (id: TeamId) => TE.TaskEither<DomainError, Team | null>;
  readonly saveTeams: (teams: readonly PrismaTeamCreate[]) => TE.TaskEither<DomainError, Teams>;
  readonly deleteAllTeams: () => TE.TaskEither<DomainError, void>;
}
