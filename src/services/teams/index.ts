import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { TeamCache } from '../../domains/teams/cache';
import { teamRepository } from '../../domains/teams/repository';
import { initializeTeamCache } from './cache';
import { createTeamServiceImpl } from './service';
import type { TeamService } from './types';

export const createTeamService = (bootstrapApi: BootstrapApi): TeamService => {
  const teamCache: TeamCache | undefined = initializeTeamCache(bootstrapApi);

  return createTeamServiceImpl({
    bootstrapApi,
    teamCache,
    teamRepository,
  });
};

export type { TeamService } from './types';
