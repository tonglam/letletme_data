import * as TE from 'fp-ts/TaskEither';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { TeamCache } from '../../domains/teams/cache/cache';
import { teamRepository } from '../../domains/teams/repository';
import type { APIError } from '../../infrastructure/http/common/errors';
import type { Team, TeamId } from '../../types/teams.type';

export type TeamServiceError = APIError & {
  code: 'CACHE_ERROR' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'SYNC_ERROR';
  details?: Record<string, unknown>;
};

export interface TeamService {
  readonly syncTeams: () => TE.TaskEither<APIError, readonly Team[]>;
  readonly getTeams: () => TE.TaskEither<APIError, readonly Team[]>;
  readonly getTeam: (id: TeamId) => TE.TaskEither<APIError, Team | null>;
  readonly getTeamByCode: (code: number) => TE.TaskEither<APIError, Team | null>;
}

export type TeamServiceDependencies = {
  readonly bootstrapApi: BootstrapApi;
  readonly teamCache?: TeamCache;
  readonly teamRepository: typeof teamRepository;
};
