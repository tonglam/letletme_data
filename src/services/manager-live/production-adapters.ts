import { redisSingleton } from '../../cache/singleton';
import { entryInfoRepository } from '../../repositories/entry-infos';
import { eventRepository } from '../../repositories/events';
import { managerScoreCheckpointRepository } from '../../repositories/live-window';
import { readManagerScoreHeadRowsWithSource } from '../../repositories/manager-score-materializations';
import { seasonRepository } from '../../repositories/seasons';
import { tournamentEntryRepository } from '../../repositories/tournament-entries';
import { tournamentInfoRepository } from '../../repositories/tournament-infos';
import { finalResultRows } from './final-result-projection';
import type { ManagerLiveOrchestrationDependencies } from './orchestration';
import { readBackgroundRows, readCachedAndCheckpointRows } from './publication-store';
import {
  buildActiveManagerLiveResult,
  buildManagerLiveResult,
  materializedProjectedRows,
  persistTournamentCoverage,
  readTournamentCoverage,
} from './result-assembly';
import {
  dispatchManagerLiveRefreshBounded,
  refreshClassicStandings,
  refreshEntrySummaries,
} from './provider-refresh';

/** Production composition root. Core orchestration only sees these ports. */
export const managerLiveProductionDependencies: ManagerLiveOrchestrationDependencies = {
  clock: { now: () => new Date() },
  redisSingleton,
  eventRepository,
  seasonRepository,
  tournamentEntryRepository,
  tournamentInfoRepository,
  entryInfoRepository,
  managerScoreCheckpointRepository,
  readManagerScoreHeadRowsWithSource,
  readCachedAndCheckpointRows,
  readBackgroundRows,
  readTournamentCoverage,
  persistTournamentCoverage,
  buildActiveManagerLiveResult,
  buildManagerLiveResult,
  materializedProjectedRows,
  refreshClassicStandings,
  refreshEntrySummaries,
  dispatchManagerLiveRefreshBounded,
  finalResultRows,
};
