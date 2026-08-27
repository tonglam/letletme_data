import type { ManagerLiveTournamentCoverageState } from '../../repositories/live-window';

/**
 * Public manager-live contract types.
 *
 * Keeping these DTOs in a dependency-light module lets API, worker and
 * orchestration code share the wire contract without importing the manager
 * live implementation (or any of its infrastructure adapters).
 */
export type ManagerLiveSource =
  | 'FPL_EVENT_LIVE'
  | 'FPL_ENTRY_SUMMARY'
  | 'FPL_CLASSIC_STANDINGS'
  | 'FPL_FINAL_RESULT';

export type ManagerLiveTotalScope = 'OVERALL' | 'CLASSIC_PHASE';
export type ManagerLiveReadMode = 'CACHE_ONLY' | 'READ_THROUGH';
export type ManagerLiveDataAvailability = 'FRESH' | 'LAST_GOOD' | 'PARTIAL' | 'UNAVAILABLE';
export type ManagerLiveServedFrom = 'REDIS' | 'POSTGRES' | 'MIXED' | 'NONE';
export type ManagerLiveCalculationMode =
  | 'OFFICIAL_CURRENT_MULTIPLIERS'
  | 'PROJECTED_AUTOSUBS'
  | 'FINAL_RESULT';

export type ManagerLiveTournamentCoverage = {
  rosterRevision: string;
  expectedEntries: number;
  resolvedEntries: number;
  fullyFetchedAt: string | null;
  managerRevision: string | null;
  error: string | null;
  state: ManagerLiveTournamentCoverageState;
};

export type ManagerScoreProvenance = {
  scoreSource: 'FPL_EVENT_LIVE' | 'FPL_FINAL_RESULT';
  calculationMode: ManagerLiveCalculationMode;
  algorithmVersion: string | null;
  inputRevision: string;
  scoreRevision: string;
  rankRevision: string | null;
  livePublicationId: string | null;
  liveRevision: string | null;
  liveCheckedAt: string | null;
  picksRevision: string | null;
  picksCheckedAt: string | null;
  previousTotalsRevision: string | null;
  previousTotalsThroughEventId: number | null;
  resultRevision: string | null;
  resultCheckedAt: string | null;
  dataCheckedAt: string | null;
  rankSource: 'FPL_ENTRY_SUMMARY' | 'FPL_CLASSIC_STANDINGS' | null;
  rankCheckedAt: string | null;
};

export type ManagerLiveScoreRow = {
  season: string;
  eventId: number;
  entryId: number;
  eventPoints: number | null;
  netEventPoints: number | null;
  totalPoints: number | null;
  totalScope: ManagerLiveTotalScope;
  eventRank: number | null;
  overallRank: number | null;
  leagueRank: number | null;
  source: ManagerLiveSource;
  transferCost: number | null;
  eventPointSemantics: 'GROSS' | 'NET' | 'ZERO_COST_EQUIVALENT' | 'UNKNOWN';
  revision: string;
  checkedAt: string;
  upstreamUpdatedAt: string | null;
  staleAt: string;
  calculationMode?: ManagerLiveCalculationMode;
  algorithmVersion?: string | null;
  provenance?: ManagerScoreProvenance;
  effectiveLineup?: readonly {
    elementId: number;
    position: number;
    sourceMultiplier: number;
    effectiveMultiplier: number;
    pickActive: boolean;
    autoSub: boolean;
    isCaptain: boolean;
    isViceCaptain: boolean;
    captainForScoring: boolean;
  }[];
};

export type ManagerLiveResolveResult = {
  season: string;
  eventId: number;
  managerRevision: string;
  dataAvailability: ManagerLiveDataAvailability;
  servedFrom: ManagerLiveServedFrom;
  refreshQueued: boolean;
  rows: ManagerLiveScoreRow[];
  missingEntryIds: number[];
  partial: boolean;
  errorCode:
    | 'UNSUPPORTED_H2H_LIVE'
    | 'UPSTREAM_UNAVAILABLE'
    | 'UPSTREAM_RATE_LIMITED'
    | 'REVISION_UNAVAILABLE'
    | 'INPUT_INCOMPLETE'
    | null;
  checkedAt: string;
  servedAt?: string;
  calculationMode: ManagerLiveCalculationMode;
  nextRefreshAt: string;
  tournamentCoverage?: ManagerLiveTournamentCoverage | null;
  /** Internal worker continuation; absent on public cache-only reads. */
  classicStandingsNextPage?: number | null;
};
