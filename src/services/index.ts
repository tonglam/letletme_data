import type { BootstrapApi } from '../domains/bootstrap/operations';
import { createEventService } from './events';
import type { EventService } from './events/types';
import { createJobService } from './jobs';
import type { JobService } from './jobs/types';
import { createPhaseService } from './phases';
import type { PhaseService } from './phases/types';
import { createPlayerStatsService } from './player-stats';
import type { PlayerStatsService } from './player-stats/types';
import { createPlayerValuesService } from './player-values';
import type { PlayerValuesService } from './player-values/types';
import { createPlayerService } from './players';
import type { PlayerService } from './players/types';
import { createTeamService } from './teams';
import type { TeamService } from './teams/types';

export interface ServiceContainer {
  readonly eventService: EventService;
  readonly phaseService: PhaseService;
  readonly playerService: PlayerService;
  readonly teamService: TeamService;
  readonly playerStatsService: PlayerStatsService;
  readonly playerValuesService: PlayerValuesService;
  readonly jobService: JobService;
}

let serviceContainer: ServiceContainer | undefined;

export const initializeServices = (bootstrapApi: BootstrapApi): ServiceContainer => {
  if (!serviceContainer) {
    serviceContainer = {
      eventService: createEventService(bootstrapApi),
      phaseService: createPhaseService(bootstrapApi),
      playerService: createPlayerService(bootstrapApi),
      teamService: createTeamService(bootstrapApi),
      playerStatsService: createPlayerStatsService(bootstrapApi),
      playerValuesService: createPlayerValuesService(bootstrapApi),
      jobService: createJobService(bootstrapApi),
    };
  }
  return serviceContainer;
};

export const getServices = (): ServiceContainer => {
  if (!serviceContainer) {
    throw new Error('Services not initialized. Call initializeServices first.');
  }
  return serviceContainer;
};
