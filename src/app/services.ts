import { createEventService } from 'services/event/service';
import { EventService } from 'services/event/types';
import { createPhaseService } from 'services/phase/service';
import { PhaseService } from 'services/phase/types';
import { createPlayerService } from 'services/player/service';
import { PlayerService } from 'services/player/types';
import { createPlayerStatService } from 'services/player-stat/service';
import { PlayerStatService } from 'services/player-stat/types';
import { createPlayerValueService } from 'services/player-value/service';
import { PlayerValueService } from 'services/player-value/types';
import { createTeamService } from 'services/team/service';
import { TeamService } from 'services/team/types';

import { ServiceDependencies } from './dependencies';

export interface ApplicationServices {
  readonly eventService: EventService;
  readonly phaseService: PhaseService;
  readonly teamService: TeamService;
  readonly playerService: PlayerService;
  readonly playerStatService: PlayerStatService;
  readonly playerValueService: PlayerValueService;
}

export const createApplicationServices = (deps: ServiceDependencies): ApplicationServices => {
  const eventService = createEventService(
    deps.fplDataService,
    deps.eventRepository,
    deps.eventCache,
  );
  const phaseService = createPhaseService(
    deps.fplDataService,
    deps.phaseRepository,
    deps.phaseCache,
  );

  const teamService = createTeamService(deps.fplDataService, deps.teamRepository, deps.teamCache);

  const playerService = createPlayerService(
    deps.fplDataService,
    deps.playerRepository,
    deps.playerCache,
  );

  const playerStatService = createPlayerStatService(
    deps.fplDataService,
    deps.playerStatRepository,
    deps.playerStatCache,
    eventService,
  );

  const playerValueService = createPlayerValueService(
    deps.fplDataService,
    deps.playerValueRepository,
    deps.playerValueCache,
    eventService,
  );

  return {
    eventService,
    phaseService,
    teamService,
    playerService,
    playerStatService,
    playerValueService,
  };
};
