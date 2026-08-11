import type {
  UnderstatMatch,
  UnderstatPlayer,
  UnderstatPlayerDiscovery,
  UnderstatPlayerMatchStat,
  UnderstatPlayerTeamSeason,
  UnderstatSeason,
  UnderstatTeamDiscovery,
  UnderstatTeamSeason,
  UnderstatTeamStatSplit,
} from '../domain/understat';
import { contentHash } from '../utils/content-hash';

type StagingKind =
  | 'team-league'
  | 'team-detail'
  | 'player-league'
  | 'player-team-detail'
  | 'player-match-detail';

interface StagingEnvelope {
  kind: StagingKind;
  season: string;
  capturedAt: string;
  data: Record<string, unknown>;
}

const STAGING_ENVELOPE_FIELDS = ['kind', 'season', 'capturedAt', 'data'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireObjectArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${label} must be an array of objects`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function requireDate(value: unknown, label: string): Date {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`);
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return result;
}

function createEnvelope(
  kind: StagingKind,
  season: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      kind,
      season,
      capturedAt: new Date().toISOString(),
      data,
    } satisfies StagingEnvelope),
  ) as Record<string, unknown>;
}

function parseEnvelope(
  payload: Record<string, unknown> | null,
  sourceHash: string | null,
  expectedKind: StagingKind,
  expectedSeason: string,
): StagingEnvelope {
  if (!payload) throw new Error(`Missing staged Understat ${expectedKind} payload`);
  if (sourceHash !== contentHash(payload)) {
    throw new Error(`Staged Understat ${expectedKind} payload hash mismatch`);
  }
  if (!hasExactFields(payload, STAGING_ENVELOPE_FIELDS)) {
    throw new Error(`Unexpected Understat staging envelope fields for ${expectedKind}`);
  }
  const envelope = payload as Partial<StagingEnvelope>;
  if (envelope.kind !== expectedKind || envelope.season !== expectedSeason) {
    throw new Error(
      `Unexpected Understat staging envelope: kind=${String(envelope.kind)} season=${String(envelope.season)}`,
    );
  }
  requireDate(envelope.capturedAt, `${expectedKind}.capturedAt`);
  requireRecord(envelope.data, `${expectedKind}.data`);
  return envelope as StagingEnvelope;
}

function hydrateSeason(value: unknown, label: string): UnderstatSeason {
  const row = requireRecord(value, label);
  return {
    ...(row as unknown as UnderstatSeason),
    firstSeenAt: requireDate(row.firstSeenAt, `${label}.firstSeenAt`),
    lastSeenAt: requireDate(row.lastSeenAt, `${label}.lastSeenAt`),
  };
}

function hydrateMatch(value: Record<string, unknown>, label: string): UnderstatMatch {
  return {
    ...(value as unknown as UnderstatMatch),
    kickoffAt: requireDate(value.kickoffAt, `${label}.kickoffAt`),
    sourceCheckedAt: requireDate(value.sourceCheckedAt, `${label}.sourceCheckedAt`),
    lastSeenAt: requireDate(value.lastSeenAt, `${label}.lastSeenAt`),
  };
}

function hydrateTeamSeason(value: Record<string, unknown>, label: string): UnderstatTeamSeason {
  return {
    ...(value as unknown as UnderstatTeamSeason),
    lastSyncedAt: requireDate(value.lastSyncedAt, `${label}.lastSyncedAt`),
  };
}

export function stageUnderstatTeamLeague(
  season: string,
  discovery: UnderstatTeamDiscovery,
): Record<string, unknown> {
  return createEnvelope('team-league', season, { discovery });
}

export function readStagedUnderstatTeamLeague(
  payload: Record<string, unknown> | null,
  sourceHash: string | null,
  season: string,
): UnderstatTeamDiscovery {
  const { data } = parseEnvelope(payload, sourceHash, 'team-league', season);
  const discovery = requireRecord(data.discovery, 'team-league.data.discovery');
  const matches = requireObjectArray(discovery.matches, 'team-league.discovery.matches');
  const teamSeasons = requireObjectArray(
    discovery.teamSeasons,
    'team-league.discovery.teamSeasons',
  );
  return {
    ...(discovery as unknown as UnderstatTeamDiscovery),
    season: hydrateSeason(discovery.season, 'team-league.discovery.season'),
    teams: requireObjectArray(
      discovery.teams,
      'team-league.discovery.teams',
    ) as unknown as UnderstatTeamDiscovery['teams'],
    matches: matches.map((row, index) => hydrateMatch(row, `team-league.matches[${index}]`)),
    teamMatchStats: requireObjectArray(
      discovery.teamMatchStats,
      'team-league.discovery.teamMatchStats',
    ) as unknown as UnderstatTeamDiscovery['teamMatchStats'],
    teamSeasons: teamSeasons.map((row, index) =>
      hydrateTeamSeason(row, `team-league.teamSeasons[${index}]`),
    ),
  };
}

export function stageUnderstatTeamDetail(
  season: string,
  teamId: number,
  rows: UnderstatTeamStatSplit[],
): Record<string, unknown> {
  return createEnvelope('team-detail', season, { teamId, rows });
}

export function readStagedUnderstatTeamDetail(
  payload: Record<string, unknown> | null,
  sourceHash: string | null,
  season: string,
): { teamId: number; rows: UnderstatTeamStatSplit[] } {
  const { data } = parseEnvelope(payload, sourceHash, 'team-detail', season);
  const teamId = requirePositiveInteger(data.teamId, 'team-detail.teamId');
  const rows = requireObjectArray(
    data.rows,
    'team-detail.rows',
  ) as unknown as UnderstatTeamStatSplit[];
  if (rows.some((row) => row.season !== season || row.teamId !== teamId)) {
    throw new Error(`Staged Understat team-detail identity mismatch for team ${teamId}`);
  }
  return { teamId, rows };
}

export function stageUnderstatPlayerLeague(
  season: string,
  discovery: UnderstatPlayerDiscovery,
): Record<string, unknown> {
  return createEnvelope('player-league', season, { discovery });
}

export function readStagedUnderstatPlayerLeague(
  payload: Record<string, unknown> | null,
  sourceHash: string | null,
  season: string,
): UnderstatPlayerDiscovery {
  const { data } = parseEnvelope(payload, sourceHash, 'player-league', season);
  const discovery = requireRecord(data.discovery, 'player-league.data.discovery');
  const matches = requireObjectArray(discovery.matches, 'player-league.discovery.matches');
  return {
    ...(discovery as unknown as UnderstatPlayerDiscovery),
    season: hydrateSeason(discovery.season, 'player-league.discovery.season'),
    teams: requireObjectArray(
      discovery.teams,
      'player-league.discovery.teams',
    ) as unknown as UnderstatPlayerDiscovery['teams'],
    matches: matches.map((row, index) => hydrateMatch(row, `player-league.matches[${index}]`)),
    players: requireObjectArray(
      discovery.players,
      'player-league.discovery.players',
    ) as unknown as UnderstatPlayerDiscovery['players'],
    playerSeasons: requireObjectArray(
      discovery.playerSeasons,
      'player-league.discovery.playerSeasons',
    ) as unknown as UnderstatPlayerDiscovery['playerSeasons'],
  };
}

export function stageUnderstatPlayerTeamDetail(
  season: string,
  teamId: number,
  players: UnderstatPlayer[],
  rows: UnderstatPlayerTeamSeason[],
): Record<string, unknown> {
  return createEnvelope('player-team-detail', season, { teamId, players, rows });
}

export function readStagedUnderstatPlayerTeamDetail(
  payload: Record<string, unknown> | null,
  sourceHash: string | null,
  season: string,
): { teamId: number; players: UnderstatPlayer[]; rows: UnderstatPlayerTeamSeason[] } {
  const { data } = parseEnvelope(payload, sourceHash, 'player-team-detail', season);
  const teamId = requirePositiveInteger(data.teamId, 'player-team-detail.teamId');
  const players = requireObjectArray(
    data.players,
    'player-team-detail.players',
  ) as unknown as UnderstatPlayer[];
  const rows = requireObjectArray(
    data.rows,
    'player-team-detail.rows',
  ) as unknown as UnderstatPlayerTeamSeason[];
  if (rows.some((row) => row.season !== season || row.teamId !== teamId)) {
    throw new Error(`Staged Understat player-team identity mismatch for team ${teamId}`);
  }
  return { teamId, players, rows };
}

export function stageUnderstatPlayerMatchDetail(
  season: string,
  matchId: number,
  players: UnderstatPlayer[],
  rows: UnderstatPlayerMatchStat[],
): Record<string, unknown> {
  return createEnvelope('player-match-detail', season, { matchId, players, rows });
}

export function readStagedUnderstatPlayerMatchDetail(
  payload: Record<string, unknown> | null,
  sourceHash: string | null,
  season: string,
): { matchId: number; players: UnderstatPlayer[]; rows: UnderstatPlayerMatchStat[] } {
  const { data } = parseEnvelope(payload, sourceHash, 'player-match-detail', season);
  const matchId = requirePositiveInteger(data.matchId, 'player-match-detail.matchId');
  const players = requireObjectArray(
    data.players,
    'player-match-detail.players',
  ) as unknown as UnderstatPlayer[];
  const rows = requireObjectArray(
    data.rows,
    'player-match-detail.rows',
  ) as unknown as UnderstatPlayerMatchStat[];
  if (rows.some((row) => row.matchId !== matchId)) {
    throw new Error(`Staged Understat player-match identity mismatch for match ${matchId}`);
  }
  return { matchId, players, rows };
}

export function understatStagingHash(payload: Record<string, unknown>): string {
  return contentHash(payload);
}
