// Compatibility facade for Manager Live. Keep existing public symbols stable while
// the production implementation is split by responsibility under ./manager-live/.
import { createManagerLiveOrchestration } from './manager-live/orchestration';
import { managerLiveProductionDependencies } from './manager-live/production-adapters';

const managerLiveOrchestration = createManagerLiveOrchestration(managerLiveProductionDependencies);

export { classicStandingsCursorAfterRefresh } from '../domain/manager-live-refresh';
export { tournamentRosterRevision } from '../domain/manager-live-coverage';
export { selectFinalizedManagerLiveEntryIds } from './manager-live/row-model';
export { projectEventLiveManagerRows } from './manager-live/final-projection';
export {
  deriveManagerLiveTournamentCoverageState,
  invalidateManagerLiveTournamentCoverage,
  shouldPreserveManagerLiveTournamentCoverage,
  shouldQueueFinalizedManagerLiveCoverage,
} from './manager-live/coverage';
export type {
  ManagerLiveCalculationMode,
  ManagerLiveDataAvailability,
  ManagerLiveReadMode,
  ManagerLiveResolveResult,
  ManagerLiveScoreRow,
  ManagerLiveServedFrom,
  ManagerLiveSource,
  ManagerLiveTotalScope,
  ManagerLiveTournamentCoverage,
  ManagerScoreProvenance,
} from './manager-live/contracts';
export {
  MANAGER_LIVE_READ_THROUGH_BACKGROUND_STANDINGS_PAGE_LIMIT,
  mergeClassicStandingWithEntrySummary,
} from './manager-live/publication-store';
export type { ClassicStandingsRefreshDependencies } from './manager-live/publication-store';
export { persistTournamentCoverage } from './manager-live/result-assembly';
export {
  enrichClassicStandingOverallRank,
  preserveClassicOverallRank,
  refreshClassicStandings,
  runManagerLivePublication,
  selectClassicOverallRankRefreshTargets,
  selectWorkerClassicFallbackTargets,
  selectWorkerSummaryRefreshTargets,
} from './manager-live/provider-refresh';
export const resolveManagerLiveScores = managerLiveOrchestration.resolve;
export const refreshManagerLiveScores = managerLiveOrchestration.refresh;
