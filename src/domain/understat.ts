export type UnderstatLane = 'team' | 'player';
export type UnderstatSyncMode = 'incremental' | 'full' | 'reconcile';
export type UnderstatSyncTrigger = 'cron' | 'manual' | 'api';
export type UnderstatSyncRunStatus =
  | 'pending'
  | 'running'
  | 'failed'
  | 'completed'
  | 'ready_to_publish'
  | 'published'
  | 'skipped';
export type UnderstatSyncItemStatus = 'pending' | 'running' | 'failed' | 'completed' | 'skipped';
export type UnderstatTeamSide = 'h' | 'a';
export type UnderstatTeamResult = 'w' | 'd' | 'l';
export type UnderstatSeasonState = 'planned' | 'active' | 'complete';
export type UnderstatSplitDimension =
  | 'situation'
  | 'formation'
  | 'gameState'
  | 'timing'
  | 'shotZone'
  | 'attackSpeed'
  | 'result';

export const UNDERSTAT_SPLIT_DIMENSIONS: readonly UnderstatSplitDimension[] = [
  'situation',
  'formation',
  'gameState',
  'timing',
  'shotZone',
  'attackSpeed',
  'result',
];

export interface UnderstatSeason {
  season: string;
  sourceYear: number;
  league: string;
  state: UnderstatSeasonState;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface UnderstatTeam {
  id: number;
  title: string;
  shortTitle: string | null;
  firstSeenSeason: string;
  lastSeenSeason: string;
  sourceHash: string;
}

export interface UnderstatMatch {
  id: number;
  season: string;
  homeTeamId: number;
  awayTeamId: number;
  kickoffAt: Date;
  isResult: boolean;
  homeGoals: number | null;
  awayGoals: number | null;
  homeXg: number | null;
  awayXg: number | null;
  forecastHomeWin: number | null;
  forecastDraw: number | null;
  forecastAwayWin: number | null;
  sourceHash: string;
  sourceCheckedAt: Date;
  lastSeenAt: Date;
}

export interface UnderstatTeamMatchStat {
  matchId: number;
  teamId: number;
  side: UnderstatTeamSide;
  xg: number;
  xga: number;
  npxg: number;
  npxga: number;
  npxgd: number;
  ppdaAtt: number;
  ppdaDef: number;
  ppdaAllowedAtt: number;
  ppdaAllowedDef: number;
  deep: number;
  deepAllowed: number;
  scored: number;
  missed: number;
  xpoints: number;
  result: UnderstatTeamResult;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  sourceHash: string;
}

export interface UnderstatTeamSeason {
  season: string;
  teamId: number;
  sourceTitle: string;
  sourceShortTitle: string | null;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  xg: number;
  xga: number;
  npxg: number;
  npxga: number;
  npxgd: number;
  xpoints: number;
  deep: number;
  deepAllowed: number;
  ppdaAtt: number;
  ppdaDef: number;
  ppdaAllowedAtt: number;
  ppdaAllowedDef: number;
  sourceHash: string;
  lastSyncedAt: Date;
}

export interface UnderstatTeamStatSplit {
  season: string;
  teamId: number;
  dimension: UnderstatSplitDimension;
  splitKey: string;
  label: string | null;
  timeMinutes: number | null;
  shotsFor: number;
  goalsFor: number;
  xgFor: number;
  shotsAgainst: number;
  goalsAgainst: number;
  xgAgainst: number;
  sourceHash: string;
}

export interface UnderstatPlayer {
  id: number;
  name: string;
  favoritePosition: string | null;
  firstSeenSeason: string;
  lastSeenSeason: string;
  sourceHash: string;
}

export interface UnderstatPlayerStats {
  games: number;
  time: number;
  goals: number;
  npg: number;
  assists: number;
  shots: number;
  keyPasses: number;
  yellowCards: number;
  redCards: number;
  xg: number;
  npxg: number;
  xa: number;
  xgChain: number;
  xgBuildup: number;
  position: string;
}

export interface UnderstatPlayerSeason extends UnderstatPlayerStats {
  season: string;
  playerId: number;
  sourceName: string;
  sourceTeamTitle: string;
  sourceHash: string;
}

export interface UnderstatPlayerTeamSeason extends UnderstatPlayerStats {
  season: string;
  playerId: number;
  teamId: number;
  sourceHash: string;
}

export interface UnderstatPlayerMatchStat {
  rosterId: number;
  matchId: number;
  playerId: number;
  teamId: number;
  playerName: string;
  side: UnderstatTeamSide;
  position: string;
  positionOrder: number;
  minutes: number;
  started: boolean;
  goals: number;
  ownGoals: number;
  shots: number;
  keyPasses: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  xg: number;
  xa: number;
  xgChain: number;
  xgBuildup: number;
  rosterInId: number | null;
  rosterOutId: number | null;
  sourceHash: string;
}

export interface UnderstatSyncRun {
  runId: string;
  lane: UnderstatLane;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  status: UnderstatSyncRunStatus;
  expectedItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
  dataChanged: boolean;
  publicationId: string | null;
  metadata: Record<string, unknown>;
  errorSummary: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface UnderstatSyncItem {
  runId: string;
  resourceType: string;
  resourceId: string;
  status: UnderstatSyncItemStatus;
  attempts: number;
  sourceHash: string | null;
  normalizedPayload: Record<string, unknown> | null;
  lastError: string | null;
  completedAt: Date | null;
}

export interface UnderstatTeamDiscovery {
  season: UnderstatSeason;
  teams: UnderstatTeam[];
  matches: UnderstatMatch[];
  teamMatchStats: UnderstatTeamMatchStat[];
  teamSeasons: UnderstatTeamSeason[];
}

export interface UnderstatPlayerDiscovery {
  season: UnderstatSeason;
  teams: UnderstatTeam[];
  matches: UnderstatMatch[];
  players: UnderstatPlayer[];
  playerSeasons: UnderstatPlayerSeason[];
}

export function sourceYearFromSeason(season: string): number {
  if (!/^\d{4}$/.test(season)) {
    throw new Error(`Invalid season key: ${season}`);
  }
  const start = Number.parseInt(season.slice(0, 2), 10);
  const end = Number.parseInt(season.slice(2), 10);
  if ((start + 1) % 100 !== end) {
    throw new Error(`Season must contain consecutive years: ${season}`);
  }
  return 2000 + start;
}
