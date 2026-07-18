// Re-export domain EventChipData/EventTopElementData for consumers that import from types.
import type { EventChipData, EventTopElementData } from '../domain/event-overall-results';

export type { EventChipData, EventTopElementData };

// Core domain types
export type EventID = number;
export type EventId = EventID;
export type PlayerID = number;
export type PlayerId = PlayerID;
export type TeamID = number;
export type TeamId = TeamID;
export type EntryID = number;
export type PhaseID = number;
export type FixtureID = number;

// Domain types (transformed/camelCase — not raw FPL shapes)
export interface Event {
  id: EventID;
  name: string;
  deadlineTime: string | null;
  averageEntryScore: number | null;
  finished: boolean;
  dataChecked: boolean;
  highestScoringEntry: number | null;
  deadlineTimeEpoch: number | null;
  deadlineTimeGameOffset: number | null;
  highestScore: number | null;
  isPrevious: boolean;
  isCurrent: boolean;
  isNext: boolean;
  cupLeagueCreate: boolean;
  h2hKoMatchesCreated: boolean;
  chipPlays: EventChipData[] | null;
  mostSelected: number | null;
  mostTransferredIn: number | null;
  topElement: number | null;
  topElementInfo: EventTopElementData | null;
  transfersMade: number | null;
  mostCaptained: number | null;
  mostViceCaptained: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface Player {
  id: PlayerID;
  code: number;
  type: number;
  teamId: TeamID;
  price: number;
  startPrice: number;
  firstName: string;
  secondName: string;
  webName: string;
}

export interface Team {
  id: TeamID;
  name: string;
  shortName: string;
  code: number;
  draw: number;
  form: string | null;
  loss: number;
  played: number;
  points: number;
  position: number;
  strength: number;
  teamDivision: number | null;
  unavailable: boolean;
  win: number;
  strengthOverallHome: number;
  strengthOverallAway: number;
  strengthAttackHome: number;
  strengthAttackAway: number;
  strengthDefenceHome: number;
  strengthDefenceAway: number;
  pulseId: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface Phase {
  id: PhaseID;
  name: string;
  startEvent: number;
  stopEvent: number;
  highestScore: number | null;
}

export interface FixtureStat {
  identifier: string;
  a: Array<{ value: number; element: number }>;
  h: Array<{ value: number; element: number }>;
}

export interface Fixture {
  id: FixtureID;
  code: number;
  event: EventID | null;
  finished: boolean;
  finishedProvisional: boolean;
  kickoffTime: Date | null;
  minutes: number;
  provisionalStartTime: boolean;
  started: boolean | null;
  teamA: TeamID;
  teamAScore: number | null;
  teamH: TeamID;
  teamHScore: number | null;
  stats: FixtureStat[];
  teamHDifficulty: number | null;
  teamADifficulty: number | null;
  pulseId: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Raw FPL API types — inferred from client Zod schemas (FP-19).
// The canonical definitions live in src/clients/fpl.ts as exported Zod schemas.
// These re-exports preserve backward compatibility for downstream importers.
// ---------------------------------------------------------------------------
export type {
  RawFPLEvent,
  RawFPLTeam,
  RawFPLElement,
  RawFPLPhase,
  RawFPLFixtureStat,
  RawFPLFixture,
  FPLBootstrapResponse,
  RawFPLEventLiveStats,
  RawFPLEventLiveElement,
  RawFPLEventLiveResponse,
  RawFPLEntrySummary,
  RawFPLLeagueItem,
  RawFPLEntryLeagues,
  RawFPLEntryEventPickItem,
  RawFPLEntryEventPicksEntryHistory,
  RawFPLEntryEventPicksResponse,
  RawFPLLeagueStandingsResult,
  RawFPLLeagueStandings,
  RawFPLLeagueInfo,
  RawFPLLeagueStandingsResponse,
  RawFPLEntryHistoryPastSeason,
  RawFPLEntryHistoryCurrentItem,
  RawFPLEntryHistoryResponse,
  RawFPLEntryTransfer,
  RawFPLEntryTransfersResponse,
  RawFPLEntryCupMatch,
  RawFPLEntryCupResponse,
  RawFPLEventExplainStat,
  RawFPLEventExplainFixture,
} from '../clients/fpl';

// Error types
export interface APIError extends Error {
  status?: number;
  code?: string;
}

// Cache types
export interface CacheConfig {
  prefix: string;
}
