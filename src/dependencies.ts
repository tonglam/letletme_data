import { createEventCache } from 'domain/event/cache';
import { createEventFixtureCache } from 'domain/event-fixture/cache';
import { createEventLiveCache } from 'domain/event-live/cache';
import { createEventOverallResultCache } from 'domain/event-overall-result/cache';
import { createPhaseCache } from 'domain/phase/cache';
import { createPlayerCache } from 'domain/player/cache';
import { createPlayerStatCache } from 'domain/player-stat/cache';
import { createPlayerValueCache } from 'domain/player-value/cache';
import { createTeamCache } from 'domain/team/cache';
import { createTeamFixtureCache } from 'domain/team-fixture/cache';

import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { createFplClassicLeagueDataService } from 'data/fpl/classic-league.data';
import { createFplEntryDataService } from 'data/fpl/entry.data';
import { createFplFixtureDataService } from 'data/fpl/fixture.data';
import { createFplH2hLeagueDataService } from 'data/fpl/h2h-league.data';
import { createFplHistoryDataService } from 'data/fpl/history.data';
import { createFplLiveDataService } from 'data/fpl/live.data';
import { createFplPickDataService } from 'data/fpl/pick.data';
import { createFplTransferDataService } from 'data/fpl/transfer.data';
import { createEntryEventPickRepository } from 'repository/entry-event-pick/repository';
import { createEntryEventResultRepository } from 'repository/entry-event-result/repository';
import { createEntryEventTransferRepository } from 'repository/entry-event-transfer/repository';
import { createEntryHistoryInfoRepository } from 'repository/entry-history-info/repository';
import { createEntryInfoRepository } from 'repository/entry-info/repository';
import { createEntryLeagueInfoRepository } from 'repository/entry-league-info/repository';
import { createEventRepository } from 'repository/event/repository';
import { createEventFixtureRepository } from 'repository/event-fixture/repository';
import { createEventLiveRepository } from 'repository/event-live/repository';
import { createEventLiveExplainRepository } from 'repository/event-live-explain/repository';
import { createPhaseRepository } from 'repository/phase/repository';
import { createPlayerRepository } from 'repository/player/repository';
import { createPlayerStatRepository } from 'repository/player-stat/repository';
import { createPlayerValueRepository } from 'repository/player-value/repository';
import { createPlayerValueTrackRepository } from 'repository/player-value-track/repository';
import { createTeamRepository } from 'repository/team/repository';
import { createTournamentBattleGroupResultRepository } from 'repository/tournament-battle-group-result/repository';
import { createTournamentEntryRepository } from 'repository/tournament-entry/repository';
import { createTournamentGroupRepository } from 'repository/tournament-group/repository';
import { createTournamentInfoRepository } from 'repository/tournament-info/repository';
import { createTournamentKnockoutRepository } from 'repository/tournament-knockout/repository';
import { createTournamentKnockoutResultRepository } from 'repository/tournament-knockout-result/repository';
import { createTournamentPointsGroupResultRepository } from 'repository/tournament-points-group-result/repository';
import { createEntryEventPickService } from 'service/entry-event-pick/service';
import { createEntryEventPickWorkflows } from 'service/entry-event-pick/workflow';
import { createEntryEventResultService } from 'service/entry-event-result/service';
import { createEntryEventResultWorkflows } from 'service/entry-event-result/workflow';
import { createEntryEventTransferService } from 'service/entry-event-transfer/service';
import { createEntryEventTransferWorkflows } from 'service/entry-event-transfer/workflow';
import { createEntryHistoryInfoService } from 'service/entry-history-info/service';
import { createEntryInfoService } from 'service/entry-info/service';
import { createEntryInfoWorkflows } from 'service/entry-info/workflow';
import { createEntryLeagueInfoService } from 'service/entry-league-info/service';
import { createEventService } from 'service/event/service';
import { createEventWorkflows } from 'service/event/workflow';
import { createEventLiveService } from 'service/event-live/service';
import { createEventLiveWorkflows } from 'service/event-live/workflow';
import { createEventLiveExplainService } from 'service/event-live-explain/service';
import { createEventLiveExplainWorkflows } from 'service/event-live-explain/workflow';
import { createEventOverallResultService } from 'service/event-overall-result/service';
import { createEventOverallResultWorkflows } from 'service/event-overall-result/workflow';
import { createFixtureService } from 'service/fixture/service';
import { createFixtureWorkflows } from 'service/fixture/workflow';
import { createPhaseService } from 'service/phase/service';
import { createPhaseWorkflows } from 'service/phase/workflow';
import { createPlayerService } from 'service/player/service';
import { createPlayerWorkflows } from 'service/player/workflow';
import { createPlayerStatService } from 'service/player-stat/service';
import { createPlayerStatWorkflows } from 'service/player-stat/workflow';
import { createPlayerValueService } from 'service/player-value/service';
import { createPlayerValueWorkflows } from 'service/player-value/workflow';
import { createPlayerValueTrackService } from 'service/player-value-track/service';
import { createPlayerValueTrackWorkflows } from 'service/player-value-track/workflow';
import { createTeamService } from 'service/team/service';
import { createTeamWorkflows } from 'service/team/workflow';
import { createTournamentService } from 'service/tournament/service';
import { createTournamentBattleGroupResultService } from 'service/tournament-battle-group-result/service';
import { createTournamentEntryService } from 'service/tournament-entry/service';
import { createTournamentGroupService } from 'service/tournament-group/service';
import { createTournamentInfoService } from 'service/tournament-info/service';
import { createTournamentKnockoutService } from 'service/tournament-knockout/service';
import { createTournamentKnockoutResultService } from 'service/tournament-knockout-result/service';
import { createTournamentPointsGroupResultService } from 'service/tournament-points-group-result/service';

// --- Instantiate Data Services ---
export const fplBootstrapDataService = createFplBootstrapDataService();
export const fplFixtureDataService = createFplFixtureDataService();
export const fplLiveDataService = createFplLiveDataService();
export const fplEntryDataService = createFplEntryDataService();
export const fplHistoryDataService = createFplHistoryDataService();
export const fplPickDataService = createFplPickDataService();
export const fplTransferDataService = createFplTransferDataService();
export const fplClassicDataService = createFplClassicLeagueDataService();
export const fplH2hDataService = createFplH2hLeagueDataService();

// --- Instantiate Repositories ---
export const eventRepository = createEventRepository();
export const phaseRepository = createPhaseRepository();
export const teamRepository = createTeamRepository();
export const playerRepository = createPlayerRepository();
export const playerValueRepository = createPlayerValueRepository();
export const playerValueTrackRepository = createPlayerValueTrackRepository();
export const playerStatRepository = createPlayerStatRepository();
export const eventFixtureRepository = createEventFixtureRepository();
export const eventLiveRepository = createEventLiveRepository();
export const eventLiveExplainRepository = createEventLiveExplainRepository();
export const entryEventResultRepository = createEntryEventResultRepository();
export const entryEventPickRepository = createEntryEventPickRepository();
export const entryEventTransferRepository = createEntryEventTransferRepository();
export const entryInfoRepository = createEntryInfoRepository();
export const entryLeagueInfoRepository = createEntryLeagueInfoRepository();
export const entryHistoryInfoRepository = createEntryHistoryInfoRepository();
export const tournamentInfoRepository = createTournamentInfoRepository();
export const tournamentEntryRepository = createTournamentEntryRepository();
export const tournamentGroupRepository = createTournamentGroupRepository();
export const tournamentPointsGroupResultRepository = createTournamentPointsGroupResultRepository();
export const tournamentBattleGroupResultRepository = createTournamentBattleGroupResultRepository();
export const tournamentKnockoutRepository = createTournamentKnockoutRepository();
export const tournamentKnockoutResultRepository = createTournamentKnockoutResultRepository();

// --- Instantiate Caches ---
export const eventCache = createEventCache();
export const phaseCache = createPhaseCache();
export const teamCache = createTeamCache();
export const playerCache = createPlayerCache();
export const playerStatCache = createPlayerStatCache();
export const playerValueCache = createPlayerValueCache();
export const eventFixtureCache = createEventFixtureCache();
export const teamFixtureCache = createTeamFixtureCache();
export const eventLiveCache = createEventLiveCache();
export const eventOverallResultCache = createEventOverallResultCache();

// --- Instantiate Services ---

export const eventService = createEventService(
  fplBootstrapDataService,
  eventRepository,
  eventCache,
  eventFixtureCache,
);

export const fixtureService = createFixtureService(
  fplFixtureDataService,
  eventFixtureRepository,
  eventFixtureCache,
  teamFixtureCache,
  eventCache,
  teamCache,
);

export const phaseService = createPhaseService(
  fplBootstrapDataService,
  phaseRepository,
  phaseCache,
);

export const teamService = createTeamService(fplBootstrapDataService, teamRepository, teamCache);

export const playerService = createPlayerService(
  fplBootstrapDataService,
  playerRepository,
  playerCache,
  teamCache,
);

export const playerValueService = createPlayerValueService(
  fplBootstrapDataService,
  playerValueRepository,
  playerValueCache,
  eventCache,
  teamCache,
  playerCache,
);

export const playerValueTrackService = createPlayerValueTrackService(
  fplBootstrapDataService,
  playerValueTrackRepository,
  eventService,
);

export const playerStatService = createPlayerStatService(
  fplBootstrapDataService,
  playerStatRepository,
  playerStatCache,
  eventCache,
  teamCache,
  playerCache,
);

export const eventLiveService = createEventLiveService(
  fplLiveDataService,
  eventLiveRepository,
  eventLiveCache,
  teamCache,
  playerCache,
  eventService,
);

export const eventLiveExplainService = createEventLiveExplainService(
  fplLiveDataService,
  eventLiveExplainRepository,
);

export const eventOverallResultService = createEventOverallResultService(
  fplBootstrapDataService,
  eventOverallResultCache,
  playerCache,
);

export const entryEventPickService = createEntryEventPickService(
  fplPickDataService,
  entryEventPickRepository,
  entryInfoRepository,
  tournamentEntryRepository,
  teamCache,
  playerCache,
);

export const entryEventTransferService = createEntryEventTransferService(
  fplTransferDataService,
  entryEventTransferRepository,
  entryInfoRepository,
  tournamentEntryRepository,
  teamCache,
  playerCache,
);

export const entryEventResultService = createEntryEventResultService(
  fplHistoryDataService,
  entryEventResultRepository,
  entryInfoRepository,
);

export const entryInfoService = createEntryInfoService(fplEntryDataService, entryInfoRepository);

export const entryLeagueInfoService = createEntryLeagueInfoService(
  fplEntryDataService,
  entryLeagueInfoRepository,
  entryInfoRepository,
);

export const entryHistoryInfoService = createEntryHistoryInfoService(
  fplHistoryDataService,
  entryHistoryInfoRepository,
  entryInfoRepository,
);

export const tournamentService = createTournamentService();

export const tournamentInfoService = createTournamentInfoService(
  tournamentInfoRepository,
  eventCache,
);

export const tournamentEntryService = createTournamentEntryService(
  fplClassicDataService,
  fplH2hDataService,
  tournamentEntryRepository,
);

export const tournamentGroupService = createTournamentGroupService(tournamentGroupRepository);

export const tournamentPointsGroupResultService = createTournamentPointsGroupResultService(
  tournamentPointsGroupResultRepository,
);

export const tournamentBattleGroupResultService = createTournamentBattleGroupResultService(
  tournamentBattleGroupResultRepository,
);

export const tournamentKnockoutService = createTournamentKnockoutService(
  tournamentKnockoutRepository,
);

export const tournamentKnockoutResultService = createTournamentKnockoutResultService(
  tournamentKnockoutResultRepository,
);

// --- Instantiate Workflow Operations ---
export const eventWorkflows = createEventWorkflows(eventService);

export const phaseWorkflows = createPhaseWorkflows(phaseService);

export const teamWorkflows = createTeamWorkflows(teamService);

export const playerWorkflows = createPlayerWorkflows(playerService);

export const playerValueWorkflows = createPlayerValueWorkflows(playerValueService);

export const playerValueTrackWorkflows = createPlayerValueTrackWorkflows(playerValueTrackService);

export const playerStatWorkflows = createPlayerStatWorkflows(playerStatService);

export const fixtureWorkflows = createFixtureWorkflows(fixtureService);

export const eventLiveWorkflows = createEventLiveWorkflows(eventService, eventLiveService);

export const eventLiveExplainWorkflows = createEventLiveExplainWorkflows(
  eventService,
  eventLiveExplainService,
);

export const eventOverallResultWorkflows = createEventOverallResultWorkflows(
  eventService,
  eventOverallResultService,
);

export const entryInfoWorkflows = createEntryInfoWorkflows(entryInfoService);

export const entryEventPickWorkflows = createEntryEventPickWorkflows(entryEventPickService);

export const entryEventTransferWorkflows =
  createEntryEventTransferWorkflows(entryEventTransferService);

export const entryEventResultWorkflows = createEntryEventResultWorkflows(entryEventResultService);

export const dependencies = {
  eventService,
  phaseService,
  teamService,
  playerService,
  fixtureService,
  playerStatService,
  playerValueService,
  playerValueTrackService,
  eventLiveService,
  eventLiveExplainService,
  entryEventPickService,
  entryEventTransferService,
  entryEventResultService,
  eventOverallResultService,
  entryInfoService,
  entryLeagueInfoService,
  entryHistoryInfoService,
  eventWorkflows,
  phaseWorkflows,
  teamWorkflows,
  playerWorkflows,
  playerValueWorkflows,
  playerValueTrackWorkflows,
  playerStatWorkflows,
  fixtureWorkflows,
  eventLiveWorkflows,
  eventLiveExplainWorkflows,
  eventOverallResultWorkflows,
  entryInfoWorkflows,
  entryEventPickWorkflows,
  entryEventTransferWorkflows,
  entryEventResultWorkflows,
};

export type DecoratedDependencies = typeof dependencies;
