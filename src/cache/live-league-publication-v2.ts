import { createHash, randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

import {
  LIVE_POINTS_CONTRACT_VERSION,
  readEntryLiveInputV2,
  validateEntryLiveInputV2,
  type EntryLiveInputV2,
  type LivePublicationState,
} from './live-publication-v2';
import { redisSingleton } from './singleton';
import { canonicalJson, contentHash } from '../utils/content-hash';
import { CacheError } from '../utils/errors';

/**
 * Live league publications are a separate immutable read model.  The global
 * and entry publications remain the producer facts; this module only binds
 * those exact references into one tournament/event serving unit.
 */
export const LIVE_LEAGUE_CONTRACT_VERSION = LIVE_POINTS_CONTRACT_VERSION;
export const LIVE_LEAGUE_PREVIOUS_TTL_MS = 24 * 60 * 60_000;
export const LIVE_LEAGUE_FINAL_TTL_MS = 48 * 60 * 60_000;
export const LIVE_LEAGUE_STAGING_TTL_MS = 15 * 60_000;
export const LIVE_LEAGUE_MAX_ENTRIES = 5_000;
export const LIVE_LEAGUE_MAX_INDEX_BYTES = 8 * 1024 * 1024;
export const LIVE_LEAGUE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const LIVE_LEAGUE_MAX_ROW_BYTES = 16 * 1024;

export type LeagueLiveScopeKind = 'CLASSIC' | 'H2H_HEAD' | 'H2H_MATCH' | 'H2H_STANDINGS';
export type LeagueLiveAvailability = 'READY' | 'PENDING' | 'MISSING' | 'ERROR';

export type LeagueLiveScope = {
  readonly season: string;
  readonly eventId: number;
  readonly tournamentId: number;
  readonly scope: LeagueLiveScopeKind;
  readonly matchId?: number;
};

export type LeagueLiveRevisionVector = {
  readonly roster: string;
  readonly scoreCore: string;
  readonly fixtureIdentity: string;
  readonly entryInputSet: string;
  readonly identity: string;
  readonly officialRank: string | null;
  readonly rules: string;
  readonly algorithm: string;
  readonly schedule: string | null;
  readonly averageSide: string | null;
  readonly content: string;
};

export type LeagueLiveIndexRow = {
  readonly entryId: number;
  readonly availability: LeagueLiveAvailability;
  readonly entryName: string;
  readonly playerName: string;
  readonly region: string | null;
  readonly startedEvent: number | null;
  readonly overallPoints: number | null;
  readonly overallRank: number | null;
  readonly bank: number | null;
  readonly teamValue: number | null;
  readonly totalTransfers: number | null;
  readonly lastEventId: number | null;
  readonly lastOverallPoints: number | null;
  readonly lastOverallRank: number | null;
  readonly lastTeamValue: number | null;
  readonly lastBank: number | null;
  readonly inputPublicationId: string | null;
  readonly inputGeneration: number | null;
  readonly inputRevision: string | null;
  readonly inputContentUpdatedAt: string | null;
};

export type H2HMatchIndexRow = {
  readonly matchId: number;
  readonly eventId: number;
  readonly groupId: number;
  readonly sourceOrder: number;
  readonly phase: 'REGULAR' | 'KNOCKOUT';
  readonly availability: 'READY' | 'PENDING' | 'ERROR';
  readonly homeEntryId: number | null;
  readonly awayEntryId: number | null;
};

export type H2HMatchSide = {
  readonly entryId: number | null;
  readonly entryName: string;
  readonly playerName: string | null;
  readonly isAverage: boolean;
  readonly officialNetPoints: number | null;
  readonly inputPublicationId: string | null;
  readonly inputGeneration: number | null;
  readonly inputRevision: string | null;
  readonly inputContentUpdatedAt: string | null;
  readonly input: EntryLiveInputV2 | null;
};

export type H2HMatchPayload = {
  readonly contractVersion: typeof LIVE_LEAGUE_CONTRACT_VERSION;
  readonly season: string;
  readonly eventId: number;
  readonly tournamentId: number;
  readonly officialMatchId: number;
  readonly groupId: number;
  readonly sourceOrder: number;
  readonly phase: 'REGULAR' | 'KNOCKOUT';
  readonly knockoutName: string | null;
  readonly tiebreak: string | null;
  readonly isBye: boolean;
  readonly state: 'READY' | 'PENDING' | 'ERROR';
  readonly sourceCheckedAt: string;
  readonly globalRef: { readonly publicationId: string; readonly generation: number };
  readonly home: H2HMatchSide;
  readonly away: H2HMatchSide;
};

export type H2HStandingsRow = {
  readonly entryId: number;
  readonly entryName: string;
  readonly playerName: string | null;
  readonly rank: number | null;
  readonly matchPoints: number | null;
  readonly played: number | null;
  readonly won: number | null;
  readonly drawn: number | null;
  readonly lost: number | null;
  readonly pointsFor: number | null;
};

export type H2HStandingsIndexRow = {
  readonly entryId: number;
  readonly availability: 'READY';
};

export type H2HStandingsPayload = {
  readonly contractVersion: typeof LIVE_LEAGUE_CONTRACT_VERSION;
  readonly season: string;
  readonly eventId: number;
  readonly tournamentId: number;
  readonly throughEventId: number;
  readonly state: 'READY' | 'UPDATING' | 'UNAVAILABLE';
  readonly sourceCheckedAt: string;
  readonly rows: readonly H2HStandingsRow[];
};

export type LeagueLiveIndex = LeagueLiveIndexRow | H2HMatchIndexRow | H2HStandingsIndexRow;

export type LeagueLiveManifest = {
  readonly contractVersion: typeof LIVE_LEAGUE_CONTRACT_VERSION;
  readonly publicationId: string;
  readonly generation: number;
  readonly season: string;
  readonly eventId: number;
  readonly tournamentId: number;
  readonly scope: LeagueLiveScopeKind;
  readonly matchId?: number;
  readonly state: LivePublicationState;
  readonly globalRef: {
    readonly publicationId: string;
    readonly generation: number;
  };
  readonly revisions: LeagueLiveRevisionVector;
  readonly times: {
    readonly sourceCheckedAt: string;
    readonly contentUpdatedAt: string;
    readonly publishedAt: string;
    readonly checkpointedAt: string | null;
    readonly expectedNextCheckAt: string | null;
  };
  readonly counts: {
    readonly expected: number;
    readonly published: number;
    readonly ready: number;
    readonly noPicks: number;
  };
  readonly items: {
    readonly index: LeaguePublicationItem;
    readonly payload: LeaguePublicationItem;
  };
};

export type LeaguePublicationItem = {
  readonly name: 'index' | 'payload';
  readonly key: string;
  readonly type: 'string';
  readonly count: number;
  readonly bytes: number;
  readonly sha256: string;
};

export type LeagueLivePayload = Record<string, unknown>;

export type LeagueLiveRead = {
  readonly publication: LeagueLiveManifest;
  readonly index: readonly LeagueLiveIndex[];
  readonly payload: LeagueLivePayload;
  readonly servedFrom: 'REDIS_CURRENT' | 'REDIS_PREVIOUS';
};

export type LeagueLiveCheckpointDesired = {
  readonly contractVersion: typeof LIVE_LEAGUE_CONTRACT_VERSION;
  readonly season: string;
  readonly eventId: number;
  readonly tournamentId: number;
  readonly scope: LeagueLiveScopeKind;
  readonly matchId?: number;
  readonly publicationId: string;
  readonly generation: number;
  readonly requestedAt: string;
  readonly force: boolean;
};

function assertScope(scope: LeagueLiveScope): void {
  if (!/^\d{4}$/.test(scope.season)) {
    throw new CacheError('Invalid live league season', 'LIVE_LEAGUE_SEASON_INVALID');
  }
  if (!Number.isSafeInteger(scope.eventId) || scope.eventId <= 0) {
    throw new CacheError('Invalid live league event', 'LIVE_LEAGUE_EVENT_INVALID');
  }
  if (!Number.isSafeInteger(scope.tournamentId) || scope.tournamentId <= 0) {
    throw new CacheError('Invalid live league tournament', 'LIVE_LEAGUE_TOURNAMENT_INVALID');
  }
  if (scope.scope === 'H2H_MATCH') {
    if (!Number.isSafeInteger(scope.matchId) || (scope.matchId ?? 0) <= 0) {
      throw new CacheError(
        'H2H match publication requires a match id',
        'LIVE_LEAGUE_MATCH_INVALID',
      );
    }
  } else if (scope.matchId !== undefined) {
    throw new CacheError(
      'Only H2H match publications may carry a match id',
      'LIVE_LEAGUE_MATCH_INVALID',
    );
  }
}

function scopeName(scope: LeagueLiveScope): string {
  assertScope(scope);
  switch (scope.scope) {
    case 'CLASSIC':
      return 'classic';
    case 'H2H_HEAD':
      return 'h2h-head';
    case 'H2H_STANDINGS':
      return 'h2h-standings';
    case 'H2H_MATCH':
      return `h2h-match-${scope.matchId}`;
  }
}

function baseKey(scope: LeagueLiveScope): string {
  return `llm:data:v2:fpl:league-live:${scope.season}:${scope.eventId}:${scope.tournamentId}:${scopeName(scope)}`;
}

export function liveLeagueV2Key(
  scope: LeagueLiveScope,
  suffix: 'active' | 'previous' | 'sequence' | 'desired' | 'checkpoint-desired',
): string {
  return `${baseKey(scope)}:${suffix}`;
}

export function liveLeagueV2ItemKey(
  scope: LeagueLiveScope,
  generation: number,
  name: 'index' | 'payload',
): string {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new CacheError('Invalid live league generation', 'LIVE_LEAGUE_GENERATION_INVALID');
  }
  return `${baseKey(scope)}:${generation}:${name}`;
}

function metadataKey(key: string): string {
  return `${key}:meta`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validNullableInteger(value: unknown, minimum?: number): boolean {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      (minimum === undefined || value >= minimum))
  );
}

function validState(value: unknown): value is LivePublicationState {
  return (
    value === 'PRE_DEADLINE' ||
    value === 'PICKS_WAIT' ||
    value === 'PICKS_PROBE' ||
    value === 'PICKS_SYNC' ||
    value === 'LIVE_ACTIVE' ||
    value === 'BETWEEN_FIXTURES' ||
    value === 'DAY_SETTLING' ||
    value === 'GW_REVIEW' ||
    value === 'FINALIZED'
  );
}

function validItem(
  value: unknown,
  expectedKey: string,
  expectedName: LeaguePublicationItem['name'],
): value is LeaguePublicationItem {
  return (
    isRecord(value) &&
    value.name === expectedName &&
    value.key === expectedKey &&
    value.type === 'string' &&
    typeof value.count === 'number' &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    validHash(value.sha256)
  );
}

function validRevisionVector(value: unknown): value is LeagueLiveRevisionVector {
  if (!isRecord(value)) return false;
  const required = [
    'roster',
    'scoreCore',
    'fixtureIdentity',
    'entryInputSet',
    'identity',
    'rules',
    'algorithm',
    'content',
  ];
  if (required.some((key) => !validHash(value[key]))) return false;
  if (
    value.officialRank !== null &&
    value.officialRank !== undefined &&
    !validHash(value.officialRank)
  )
    return false;
  if (value.schedule !== null && value.schedule !== undefined && !validHash(value.schedule))
    return false;
  if (
    value.averageSide !== null &&
    value.averageSide !== undefined &&
    !validHash(value.averageSide)
  )
    return false;
  return true;
}

function parseManifest(raw: string | null, scope: LeagueLiveScope): LeagueLiveManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    const generation = value.generation;
    const counts = value.counts;
    if (!isRecord(counts)) return null;
    const { expected, published, ready, noPicks } = counts;
    if (
      typeof expected !== 'number' ||
      !Number.isSafeInteger(expected) ||
      expected < 0 ||
      typeof published !== 'number' ||
      !Number.isSafeInteger(published) ||
      published < 0 ||
      typeof ready !== 'number' ||
      !Number.isSafeInteger(ready) ||
      ready < 0 ||
      typeof noPicks !== 'number' ||
      !Number.isSafeInteger(noPicks) ||
      noPicks < 0
    )
      return null;
    const countsAreValid =
      scope.scope === 'CLASSIC'
        ? published === expected && published === ready + noPicks
        : published === expected && ready <= expected && noPicks <= expected;
    if (!countsAreValid) return null;
    if (
      value.contractVersion !== LIVE_LEAGUE_CONTRACT_VERSION ||
      typeof value.publicationId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.publicationId) ||
      typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation <= 0 ||
      value.season !== scope.season ||
      value.eventId !== scope.eventId ||
      value.tournamentId !== scope.tournamentId ||
      value.scope !== scope.scope ||
      (scope.scope === 'H2H_MATCH' && value.matchId !== scope.matchId) ||
      (scope.scope !== 'H2H_MATCH' && value.matchId !== undefined) ||
      !validState(value.state) ||
      !isRecord(value.globalRef) ||
      typeof value.globalRef.publicationId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.globalRef.publicationId) ||
      typeof value.globalRef.generation !== 'number' ||
      !Number.isSafeInteger(value.globalRef.generation) ||
      value.globalRef.generation <= 0 ||
      !validRevisionVector(value.revisions) ||
      !isRecord(value.times) ||
      !validIso(value.times.sourceCheckedAt) ||
      !validIso(value.times.contentUpdatedAt) ||
      !validIso(value.times.publishedAt) ||
      (value.times.checkpointedAt !== null && !validIso(value.times.checkpointedAt)) ||
      (value.times.expectedNextCheckAt !== null && !validIso(value.times.expectedNextCheckAt)) ||
      !isRecord(value.items)
    )
      return null;
    const items = value.items;
    if (
      !validItem(items.index, liveLeagueV2ItemKey(scope, generation, 'index'), 'index') ||
      !validItem(items.payload, liveLeagueV2ItemKey(scope, generation, 'payload'), 'payload')
    )
      return null;
    return value as unknown as LeagueLiveManifest;
  } catch {
    return null;
  }
}

export function parseLiveLeaguePublicationV2Manifest(
  raw: string | null,
  scope: LeagueLiveScope,
): LeagueLiveManifest | null {
  return parseManifest(raw, scope);
}

function validIndexRow(value: unknown): value is LeagueLiveIndexRow {
  return (
    isRecord(value) &&
    typeof value.entryId === 'number' &&
    Number.isSafeInteger(value.entryId) &&
    value.entryId > 0 &&
    (value.availability === 'READY' || value.availability === 'NO_PICKS') &&
    typeof value.entryName === 'string' &&
    value.entryName.length > 0 &&
    typeof value.playerName === 'string' &&
    value.playerName.length > 0 &&
    (value.region === null || typeof value.region === 'string') &&
    (value.startedEvent === null ||
      (typeof value.startedEvent === 'number' &&
        Number.isSafeInteger(value.startedEvent) &&
        value.startedEvent > 0)) &&
    (value.overallPoints === null ||
      (typeof value.overallPoints === 'number' && Number.isSafeInteger(value.overallPoints))) &&
    (value.overallRank === null ||
      (typeof value.overallRank === 'number' &&
        Number.isSafeInteger(value.overallRank) &&
        value.overallRank > 0)) &&
    (value.bank === null ||
      (typeof value.bank === 'number' && Number.isSafeInteger(value.bank) && value.bank >= 0)) &&
    (value.teamValue === null ||
      (typeof value.teamValue === 'number' &&
        Number.isSafeInteger(value.teamValue) &&
        value.teamValue >= 0)) &&
    (value.totalTransfers === null ||
      (typeof value.totalTransfers === 'number' &&
        Number.isSafeInteger(value.totalTransfers) &&
        value.totalTransfers >= 0)) &&
    (value.lastEventId === null ||
      (typeof value.lastEventId === 'number' &&
        Number.isSafeInteger(value.lastEventId) &&
        value.lastEventId >= 0)) &&
    (value.lastOverallPoints === null ||
      (typeof value.lastOverallPoints === 'number' &&
        Number.isSafeInteger(value.lastOverallPoints))) &&
    (value.lastOverallRank === null ||
      (typeof value.lastOverallRank === 'number' &&
        Number.isSafeInteger(value.lastOverallRank) &&
        value.lastOverallRank > 0)) &&
    (value.lastTeamValue === null ||
      (typeof value.lastTeamValue === 'number' &&
        Number.isSafeInteger(value.lastTeamValue) &&
        value.lastTeamValue >= 0)) &&
    (value.lastBank === null ||
      (typeof value.lastBank === 'number' &&
        Number.isSafeInteger(value.lastBank) &&
        value.lastBank >= 0)) &&
    (value.inputPublicationId === null ||
      (typeof value.inputPublicationId === 'string' &&
        /^[0-9a-f-]{36}$/i.test(value.inputPublicationId) &&
        value.inputPublicationId.length === 36)) &&
    (value.inputGeneration === null ||
      (typeof value.inputGeneration === 'number' &&
        Number.isSafeInteger(value.inputGeneration) &&
        value.inputGeneration > 0)) &&
    (value.inputRevision === null || validHash(value.inputRevision)) &&
    (value.inputContentUpdatedAt === null || validIso(value.inputContentUpdatedAt))
  );
}

function validClassicPayload(
  index: unknown,
  payload: unknown,
  manifest: LeagueLiveManifest,
): index is LeagueLiveIndexRow[] {
  if (!Array.isArray(index) || !isRecord(payload)) return false;
  if (
    index.length !== manifest.items.index.count ||
    Object.keys(payload).length !== manifest.items.payload.count
  )
    return false;
  if (index.length !== manifest.counts.expected || index.length !== Object.keys(payload).length)
    return false;
  const ids = new Set<number>();
  for (const row of index) {
    if (!validIndexRow(row) || ids.has(row.entryId)) return false;
    ids.add(row.entryId);
    const input = payload[String(row.entryId)];
    if (row.availability === 'READY') {
      if (
        row.inputPublicationId === null ||
        row.inputGeneration === null ||
        row.inputRevision === null ||
        row.inputContentUpdatedAt === null ||
        !validateEntryLiveInputV2(input, {
          season: manifest.season,
          eventId: manifest.eventId,
          entryId: row.entryId,
        }) ||
        leagueEntryInputRevision(input) !== row.inputRevision
      )
        return false;
    } else if (input !== null) {
      return false;
    }
  }
  for (const key of Object.keys(payload)) {
    if (!/^\d+$/.test(key) || !ids.has(Number(key))) return false;
  }
  return (
    manifest.counts.ready === index.filter((row) => row.availability === 'READY').length &&
    manifest.counts.noPicks === index.filter((row) => row.availability === 'NO_PICKS').length
  );
}

function validH2HMatchIndexRow(value: unknown): value is H2HMatchIndexRow {
  return (
    isRecord(value) &&
    typeof value.matchId === 'number' &&
    Number.isSafeInteger(value.matchId) &&
    value.matchId > 0 &&
    typeof value.eventId === 'number' &&
    Number.isSafeInteger(value.eventId) &&
    value.eventId > 0 &&
    typeof value.groupId === 'number' &&
    Number.isSafeInteger(value.groupId) &&
    value.groupId > 0 &&
    typeof value.sourceOrder === 'number' &&
    Number.isSafeInteger(value.sourceOrder) &&
    value.sourceOrder >= 0 &&
    (value.phase === 'REGULAR' || value.phase === 'KNOCKOUT') &&
    (value.homeEntryId === null ||
      (typeof value.homeEntryId === 'number' &&
        Number.isSafeInteger(value.homeEntryId) &&
        value.homeEntryId > 0)) &&
    (value.awayEntryId === null ||
      (typeof value.awayEntryId === 'number' &&
        Number.isSafeInteger(value.awayEntryId) &&
        value.awayEntryId > 0)) &&
    (value.availability === 'READY' ||
      value.availability === 'PENDING' ||
      value.availability === 'ERROR')
  );
}

function validH2HMatchSide(value: unknown, manifest: LeagueLiveManifest): value is H2HMatchSide {
  if (!isRecord(value)) return false;
  const entryId = value.entryId;
  const realEntry = entryId !== null;
  if (
    (entryId !== null &&
      (typeof entryId !== 'number' || !Number.isSafeInteger(entryId) || entryId <= 0)) ||
    typeof value.entryName !== 'string' ||
    value.entryName.length === 0 ||
    (value.playerName !== null && typeof value.playerName !== 'string') ||
    typeof value.isAverage !== 'boolean' ||
    (typeof value.officialNetPoints !== 'number' && value.officialNetPoints !== null) ||
    (value.officialNetPoints !== null && !Number.isSafeInteger(value.officialNetPoints)) ||
    (value.inputPublicationId !== null &&
      (typeof value.inputPublicationId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(value.inputPublicationId))) ||
    (value.inputGeneration !== null &&
      (typeof value.inputGeneration !== 'number' ||
        !Number.isSafeInteger(value.inputGeneration) ||
        value.inputGeneration <= 0)) ||
    (value.inputRevision !== null && !validHash(value.inputRevision)) ||
    (value.inputContentUpdatedAt !== null && !validIso(value.inputContentUpdatedAt))
  )
    return false;
  if (!realEntry) {
    return (
      value.isAverage === true &&
      value.inputPublicationId === null &&
      value.inputGeneration === null &&
      value.inputRevision === null &&
      value.inputContentUpdatedAt === null &&
      value.input === null
    );
  }
  return (
    value.isAverage === false &&
    validateEntryLiveInputV2(value.input, {
      season: manifest.season,
      eventId: manifest.eventId,
      entryId: entryId as number,
    }) &&
    value.inputPublicationId !== null &&
    value.inputGeneration !== null &&
    value.inputRevision !== null &&
    value.inputContentUpdatedAt !== null &&
    leagueEntryInputRevision(value.input) === value.inputRevision
  );
}

function validH2HMatchPayload(
  value: unknown,
  manifest: LeagueLiveManifest,
): value is H2HMatchPayload {
  return (
    isRecord(value) &&
    value.contractVersion === LIVE_LEAGUE_CONTRACT_VERSION &&
    value.season === manifest.season &&
    value.eventId === manifest.eventId &&
    value.tournamentId === manifest.tournamentId &&
    typeof value.officialMatchId === 'number' &&
    Number.isSafeInteger(value.officialMatchId) &&
    value.officialMatchId > 0 &&
    typeof value.groupId === 'number' &&
    Number.isSafeInteger(value.groupId) &&
    value.groupId > 0 &&
    typeof value.sourceOrder === 'number' &&
    Number.isSafeInteger(value.sourceOrder) &&
    value.sourceOrder >= 0 &&
    (value.phase === 'REGULAR' || value.phase === 'KNOCKOUT') &&
    (value.knockoutName === null || typeof value.knockoutName === 'string') &&
    (value.tiebreak === null || typeof value.tiebreak === 'string') &&
    typeof value.isBye === 'boolean' &&
    (value.state === 'READY' || value.state === 'PENDING' || value.state === 'ERROR') &&
    validIso(value.sourceCheckedAt) &&
    isRecord(value.globalRef) &&
    typeof value.globalRef.publicationId === 'string' &&
    /^[0-9a-f-]{36}$/i.test(value.globalRef.publicationId) &&
    typeof value.globalRef.generation === 'number' &&
    Number.isSafeInteger(value.globalRef.generation) &&
    value.globalRef.generation > 0 &&
    validH2HMatchSide(value.home, manifest) &&
    validH2HMatchSide(value.away, manifest) &&
    (value.state === 'READY'
      ? (value.home.entryId === null || value.home.input !== null) &&
        (value.away.entryId === null || value.away.input !== null)
      : true)
  );
}

function validH2HStandingsIndexRow(value: unknown): value is H2HStandingsIndexRow {
  return (
    isRecord(value) &&
    typeof value.entryId === 'number' &&
    Number.isSafeInteger(value.entryId) &&
    value.entryId > 0 &&
    value.availability === 'READY'
  );
}

function validH2HStandingsPayload(
  value: unknown,
  manifest: LeagueLiveManifest,
): value is { standings: H2HStandingsPayload } {
  if (!isRecord(value) || !isRecord(value.standings)) return false;
  const standings = value.standings;
  if (
    standings.contractVersion !== LIVE_LEAGUE_CONTRACT_VERSION ||
    standings.season !== manifest.season ||
    standings.eventId !== manifest.eventId ||
    standings.tournamentId !== manifest.tournamentId ||
    typeof standings.throughEventId !== 'number' ||
    !Number.isSafeInteger(standings.throughEventId) ||
    standings.throughEventId <= 0 ||
    (standings.state !== 'READY' &&
      standings.state !== 'UPDATING' &&
      standings.state !== 'UNAVAILABLE') ||
    !validIso(standings.sourceCheckedAt) ||
    !Array.isArray(standings.rows)
  )
    return false;
  const ids = new Set<number>();
  for (const row of standings.rows) {
    if (
      !isRecord(row) ||
      typeof row.entryId !== 'number' ||
      !Number.isSafeInteger(row.entryId) ||
      row.entryId <= 0 ||
      ids.has(row.entryId) ||
      typeof row.entryName !== 'string' ||
      row.entryName.length === 0 ||
      (row.playerName !== null && typeof row.playerName !== 'string') ||
      !validNullableInteger(row.rank, 1) ||
      !validNullableInteger(row.matchPoints, 0) ||
      !validNullableInteger(row.played, 0) ||
      !validNullableInteger(row.won, 0) ||
      !validNullableInteger(row.drawn, 0) ||
      !validNullableInteger(row.lost, 0) ||
      !validNullableInteger(row.pointsFor)
    )
      return false;
    ids.add(row.entryId);
  }
  if (standings.state === 'READY') return standings.rows.length > 0;
  if (standings.state === 'UNAVAILABLE') return standings.rows.length === 0;
  return true;
}

function validH2HPayload(
  index: unknown,
  payload: unknown,
  manifest: LeagueLiveManifest,
): index is LeagueLiveIndex[] {
  if (!Array.isArray(index) || !isRecord(payload)) return false;
  if (manifest.scope === 'H2H_STANDINGS') {
    if (
      manifest.items.payload.count !== 1 ||
      Object.keys(payload).length !== 1 ||
      !validH2HStandingsPayload(payload, manifest) ||
      index.length !== manifest.counts.expected ||
      manifest.counts.published !== index.length ||
      manifest.counts.ready !== index.length
    )
      return false;
    const rows = payload.standings.rows;
    const ids = new Set<number>();
    for (const row of index) {
      if (!validH2HStandingsIndexRow(row) || ids.has(row.entryId)) return false;
      ids.add(row.entryId);
    }
    return rows.length === index.length && rows.every((row) => ids.has(row.entryId));
  }
  const rows = index;
  const matchRows = rows.filter(validH2HMatchIndexRow);
  if (matchRows.length !== rows.length || rows.length !== manifest.counts.expected) return false;
  const ids = new Set<number>();
  for (const row of matchRows) {
    if (ids.has(row.matchId)) return false;
    ids.add(row.matchId);
    const match = payload[String(row.matchId)];
    if (!validH2HMatchPayload(match, manifest) || match.officialMatchId !== row.matchId)
      return false;
    if (match.state !== row.availability) return false;
    if (match.home.entryId !== row.homeEntryId || match.away.entryId !== row.awayEntryId)
      return false;
  }
  if (
    Object.keys(payload).length !== rows.length ||
    Object.keys(payload).some((key) => !/^\d+$/.test(key) || !ids.has(Number(key)))
  )
    return false;
  if (
    manifest.scope === 'H2H_MATCH' &&
    (manifest.matchId === undefined || !ids.has(manifest.matchId))
  )
    return false;
  return (
    manifest.counts.published === rows.length &&
    manifest.counts.ready === matchRows.filter((row) => row.availability === 'READY').length
  );
}

function payloadCount(value: LeagueLivePayload): number {
  return Object.keys(value).length;
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function hashSerializedPayload(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function item(
  scope: LeagueLiveScope,
  generation: number,
  name: 'index' | 'payload',
  value: unknown,
): { readonly manifest: LeaguePublicationItem; readonly payload: string } {
  const payload = canonicalJson(value);
  return {
    manifest: {
      name,
      key: liveLeagueV2ItemKey(scope, generation, name),
      type: 'string',
      count: Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : 0,
      bytes: Buffer.byteLength(payload, 'utf8'),
      sha256: hashPayload(value),
    },
    payload,
  };
}

const ALLOCATE_GENERATION_LUA = `
local floor = tonumber(ARGV[1]) or 0
local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
if current < floor then redis.call('SET', KEYS[1], tostring(floor)) end
local generation = redis.call('INCR', KEYS[1])
local now = redis.call('TIME')
return {tostring(generation), tostring(now[1]), tostring(now[2])}
`;

const PROMOTE_LUA = `
local candidate = cjson.decode(ARGV[1])
local observed = ARGV[4] or ''
local currentRaw = redis.call('GET', KEYS[1]) or ''
if currentRaw ~= observed then return {'changed', currentRaw} end
if candidate.contractVersion ~= 'live-points-v2' or not candidate.items then return {'invalid_candidate'} end
local function validItem(item, name)
  return item and item.name == name and item.type == 'string' and type(item.key) == 'string' and type(item.count) == 'number' and item.count >= 0 and type(item.bytes) == 'number' and item.bytes >= 0 and type(item.sha256) == 'string' and string.len(item.sha256) == 64
end
for _, name in ipairs({'index', 'payload'}) do
  local descriptor = candidate.items[name]
  if not validItem(descriptor, name) then return {'invalid_item'} end
  if redis.call('EXISTS', descriptor.key) ~= 1 then return {'missing_stage', descriptor.key} end
  local itemType = redis.call('TYPE', descriptor.key)
  local actualType = type(itemType) == 'table' and itemType['ok'] or itemType
  if actualType ~= 'string' or redis.call('STRLEN', descriptor.key) ~= descriptor.bytes or redis.call('GET', descriptor.key .. ':meta') ~= tostring(descriptor.count) .. '|' .. tostring(descriptor.bytes) .. '|' .. descriptor.sha256 then return {'invalid_stage', descriptor.key} end
end
local current = nil
if currentRaw ~= '' then
  local ok, decoded = pcall(cjson.decode, currentRaw)
  if ok and decoded.contractVersion == 'live-points-v2' and type(decoded.generation) == 'number' then current = decoded end
end
if current and current.generation >= candidate.generation then return {'stale', currentRaw} end
if current and current.state == 'FINALIZED' then return {'stale', currentRaw} end
if current then
  redis.call('SET', KEYS[2], currentRaw, 'PX', ARGV[2])
  for _, name in ipairs({'index', 'payload'}) do
    local old = current.items and current.items[name]
    if old and old.key then
      redis.call('PEXPIRE', old.key, ARGV[2])
      redis.call('PEXPIRE', old.key .. ':meta', ARGV[2])
    end
  end
end
for _, name in ipairs({'index', 'payload'}) do
  local descriptor = candidate.items[name]
  if candidate.state == 'FINALIZED' then
    redis.call('PEXPIRE', descriptor.key, ARGV[3])
    redis.call('PEXPIRE', descriptor.key .. ':meta', ARGV[3])
  else
    redis.call('PERSIST', descriptor.key)
    redis.call('PERSIST', descriptor.key .. ':meta')
  end
end
redis.call('SET', KEYS[1], ARGV[1])
if candidate.state == 'FINALIZED' then redis.call('PEXPIRE', KEYS[1], ARGV[3]) else redis.call('PERSIST', KEYS[1]) end
local sequence = tonumber(redis.call('GET', KEYS[3]) or '0') or 0
if sequence < candidate.generation then redis.call('SET', KEYS[3], tostring(candidate.generation)) end
return {'published', currentRaw}
`;

const TOUCH_LUA = `
local currentRaw = redis.call('GET', KEYS[1]) or ''
if currentRaw ~= ARGV[1] then return {'changed', currentRaw} end
local ok, current = pcall(cjson.decode, currentRaw)
local nextOk, next = pcall(cjson.decode, ARGV[2])
if not ok or not nextOk or current.publicationId ~= next.publicationId or current.generation ~= next.generation or current.revisions.content ~= next.revisions.content then
  return {'invalid'}
end
redis.call('SET', KEYS[1], ARGV[2])
if next.state == 'FINALIZED' then redis.call('PEXPIRE', KEYS[1], ARGV[3]) else redis.call('PERSIST', KEYS[1]) end
return {'touched', ARGV[2]}
`;

const CHECKPOINT_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) then return {'changed'} end
value.times.checkpointedAt = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(value))
if value.state == 'FINALIZED' then
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
else
  redis.call('PERSIST', KEYS[1])
end
return {'checkpointed', cjson.encode(value)}
`;

const SET_DESIRED_LUA = `
local existingRaw = redis.call('GET', KEYS[1])
if existingRaw then
  local ok, existing = pcall(cjson.decode, existingRaw)
  if ok and type(existing.generation) == 'number' then
    local generation = tonumber(ARGV[2])
    if existing.generation > generation or (existing.generation == generation and existing.publicationId ~= ARGV[1]) then return {'kept', existingRaw} end
  end
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return {'set', ARGV[3]}
`;

const CLEAR_DESIRED_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) then return 0 end
return redis.call('DEL', KEYS[1])
`;

async function allocateGeneration(
  redis: Redis,
  sequenceKey: string,
  floor: number,
): Promise<{ readonly generation: number; readonly now: string }> {
  const result = (await redis.eval(ALLOCATE_GENERATION_LUA, 1, sequenceKey, String(floor))) as [
    string,
    string,
    string,
  ];
  const generation = Number(result[0]);
  const seconds = Number(result[1]);
  const micros = Number(result[2]);
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(micros)
  ) {
    throw new CacheError(
      'Redis did not allocate a live league generation',
      'LIVE_LEAGUE_SEQUENCE_FAILED',
    );
  }
  return { generation, now: new Date(seconds * 1_000 + Math.floor(micros / 1_000)).toISOString() };
}

async function stage(
  redis: Redis,
  values: readonly { readonly manifest: LeaguePublicationItem; readonly payload: string }[],
): Promise<void> {
  const pipeline = redis.pipeline();
  for (const value of values) {
    pipeline.set(value.manifest.key, value.payload, 'PX', LIVE_LEAGUE_STAGING_TTL_MS);
    pipeline.set(
      metadataKey(value.manifest.key),
      `${value.manifest.count}|${value.manifest.bytes}|${value.manifest.sha256}`,
      'PX',
      LIVE_LEAGUE_STAGING_TTL_MS,
    );
  }
  const result = await pipeline.exec();
  if (!result || result.some(([error]) => error)) {
    throw new CacheError('Live league publication staging failed', 'LIVE_LEAGUE_STAGE_FAILED');
  }
  const payloads = await redis.mget(
    ...values.flatMap((value) => [value.manifest.key, metadataKey(value.manifest.key)]),
  );
  for (const [index, value] of values.entries()) {
    const payload = payloads[index * 2];
    const metadata = payloads[index * 2 + 1];
    if (
      payload === null ||
      metadata !== `${value.manifest.count}|${value.manifest.bytes}|${value.manifest.sha256}` ||
      Buffer.byteLength(payload, 'utf8') !== value.manifest.bytes ||
      hashSerializedPayload(payload) !== value.manifest.sha256
    ) {
      throw new CacheError(
        `Live league ${value.manifest.name} checksum failed`,
        'LIVE_LEAGUE_CHECKSUM_FAILED',
      );
    }
    try {
      JSON.parse(payload);
    } catch {
      throw new CacheError(
        `Live league ${value.manifest.name} is not JSON`,
        'LIVE_LEAGUE_PAYLOAD_INVALID',
      );
    }
  }
}

function sourceDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new CacheError('Invalid live league timestamp', 'LIVE_LEAGUE_TIME_INVALID');
  return date.toISOString();
}

type LiveLeaguePublicationInput = {
  readonly scope: LeagueLiveScope;
  readonly state: LivePublicationState;
  readonly sourceCheckedAt: Date | string;
  readonly contentUpdatedAt?: Date | string;
  readonly expectedNextCheckAt?: Date | string | null;
  readonly globalRef: { readonly publicationId: string; readonly generation: number };
  readonly revisions: LeagueLiveRevisionVector;
  readonly counts: LeagueLiveManifest['counts'];
  readonly index: readonly LeagueLiveIndex[];
  readonly payload: LeagueLivePayload;
  readonly previous?: LeagueLiveManifest | null;
  readonly generationFloor?: number;
  readonly redis?: Redis;
};

function validationManifest(input: LiveLeaguePublicationInput): LeagueLiveManifest {
  return {
    contractVersion: LIVE_LEAGUE_CONTRACT_VERSION,
    publicationId: randomUUID(),
    generation: 1,
    season: input.scope.season,
    eventId: input.scope.eventId,
    tournamentId: input.scope.tournamentId,
    scope: input.scope.scope,
    ...(input.scope.matchId === undefined ? {} : { matchId: input.scope.matchId }),
    state: input.state,
    globalRef: input.globalRef,
    revisions: input.revisions,
    times: {
      sourceCheckedAt: sourceDate(input.sourceCheckedAt),
      contentUpdatedAt: sourceDate(input.contentUpdatedAt ?? input.sourceCheckedAt),
      publishedAt: sourceDate(input.sourceCheckedAt),
      checkpointedAt: null,
      expectedNextCheckAt: null,
    },
    counts: input.counts,
    items: {
      index: {
        name: 'index',
        key: '',
        type: 'string',
        count: input.index.length,
        bytes: 0,
        sha256: hashPayload(input.index),
      },
      payload: {
        name: 'payload',
        key: '',
        type: 'string',
        count: payloadCount(input.payload),
        bytes: 0,
        sha256: hashPayload(input.payload),
      },
    },
  };
}

export async function publishLiveLeaguePublicationV2(input: LiveLeaguePublicationInput): Promise<{
  readonly publication: LeagueLiveManifest;
  readonly previous: LeagueLiveManifest | null;
  readonly published: boolean;
}> {
  assertScope(input.scope);
  if (
    input.index.length > LIVE_LEAGUE_MAX_ENTRIES ||
    payloadCount(input.payload) > LIVE_LEAGUE_MAX_ENTRIES
  ) {
    throw new CacheError(
      'Live league publication exceeds entry limit',
      'LIVE_LEAGUE_LIMIT_EXCEEDED',
    );
  }
  if (
    input.counts.expected !== input.index.length ||
    (input.scope.scope === 'CLASSIC'
      ? input.counts.published !== input.counts.ready + input.counts.noPicks ||
        input.counts.published !== input.index.length
      : input.counts.published !== input.index.length ||
        input.counts.ready > input.counts.published ||
        input.counts.noPicks > input.counts.published)
  ) {
    throw new CacheError(
      'Live league publication counts are incomplete',
      'LIVE_LEAGUE_COUNTS_INVALID',
    );
  }
  if (
    input.scope.scope !== 'CLASSIC' &&
    !validH2HPayload(input.index, input.payload, validationManifest(input))
  ) {
    throw new CacheError('Live league H2H payload is incomplete', 'LIVE_LEAGUE_PAYLOAD_INVALID');
  }
  if (
    input.scope.scope === 'CLASSIC' &&
    !validClassicPayload(input.index, input.payload, {
      contractVersion: LIVE_LEAGUE_CONTRACT_VERSION,
      publicationId: randomUUID(),
      generation: 1,
      season: input.scope.season,
      eventId: input.scope.eventId,
      tournamentId: input.scope.tournamentId,
      scope: input.scope.scope,
      state: input.state,
      globalRef: input.globalRef,
      revisions: input.revisions,
      times: {
        sourceCheckedAt: sourceDate(input.sourceCheckedAt),
        contentUpdatedAt: sourceDate(input.contentUpdatedAt ?? input.sourceCheckedAt),
        publishedAt: sourceDate(input.sourceCheckedAt),
        checkpointedAt: null,
        expectedNextCheckAt: null,
      },
      counts: input.counts,
      items: {
        index: {
          name: 'index',
          key: '',
          type: 'string',
          count: input.index.length,
          bytes: 0,
          sha256: hashPayload(input.index),
        },
        payload: {
          name: 'payload',
          key: '',
          type: 'string',
          count: payloadCount(input.payload),
          bytes: 0,
          sha256: hashPayload(input.payload),
        },
      },
    })
  ) {
    throw new CacheError(
      'Live league classic payload is incomplete',
      'LIVE_LEAGUE_PAYLOAD_INVALID',
    );
  }
  const redis = input.redis ?? (await redisSingleton.getClient());
  const currentRaw = (await redis.get(liveLeagueV2Key(input.scope, 'active'))) ?? '';
  const current = parseManifest(currentRaw, input.scope);
  const contentUpdatedAt = sourceDate(input.contentUpdatedAt ?? input.sourceCheckedAt);
  if (
    current &&
    current.revisions.content === input.revisions.content &&
    current.globalRef.publicationId === input.globalRef.publicationId &&
    current.globalRef.generation === input.globalRef.generation &&
    current.state === input.state &&
    current.counts.expected === input.counts.expected
  ) {
    const next: LeagueLiveManifest = {
      ...current,
      times: {
        ...current.times,
        sourceCheckedAt: sourceDate(input.sourceCheckedAt),
        expectedNextCheckAt:
          input.expectedNextCheckAt === undefined
            ? current.times.expectedNextCheckAt
            : input.expectedNextCheckAt === null
              ? null
              : sourceDate(input.expectedNextCheckAt),
      },
    };
    const touched = await touchLiveLeaguePublicationV2(next, currentRaw, redis);
    if (touched) return { publication: touched, previous: null, published: false };
    const raced = parseManifest(
      await redis.get(liveLeagueV2Key(input.scope, 'active')),
      input.scope,
    );
    if (raced) return { publication: raced, previous: null, published: false };
  }
  const allocation = await allocateGeneration(
    redis,
    liveLeagueV2Key(input.scope, 'sequence'),
    Math.max(input.generationFloor ?? 0, input.previous?.generation ?? 0, current?.generation ?? 0),
  );
  const indexItem = item(input.scope, allocation.generation, 'index', input.index);
  const payloadItem = item(input.scope, allocation.generation, 'payload', input.payload);
  if (
    indexItem.manifest.bytes > LIVE_LEAGUE_MAX_INDEX_BYTES ||
    payloadItem.manifest.bytes > LIVE_LEAGUE_MAX_PAYLOAD_BYTES
  ) {
    throw new CacheError(
      'Live league publication exceeds payload limit',
      'LIVE_LEAGUE_PAYLOAD_LIMIT_EXCEEDED',
    );
  }
  const manifest: LeagueLiveManifest = {
    contractVersion: LIVE_LEAGUE_CONTRACT_VERSION,
    publicationId: randomUUID(),
    generation: allocation.generation,
    season: input.scope.season,
    eventId: input.scope.eventId,
    tournamentId: input.scope.tournamentId,
    scope: input.scope.scope,
    ...(input.scope.matchId === undefined ? {} : { matchId: input.scope.matchId }),
    state: input.state,
    globalRef: input.globalRef,
    revisions: input.revisions,
    times: {
      sourceCheckedAt: sourceDate(input.sourceCheckedAt),
      contentUpdatedAt,
      publishedAt: allocation.now,
      checkpointedAt: null,
      expectedNextCheckAt:
        input.expectedNextCheckAt == null ? null : sourceDate(input.expectedNextCheckAt),
    },
    counts: input.counts,
    items: { index: indexItem.manifest, payload: payloadItem.manifest },
  };
  await stage(redis, [indexItem, payloadItem]);
  const result = (await redis.eval(
    PROMOTE_LUA,
    3,
    liveLeagueV2Key(input.scope, 'active'),
    liveLeagueV2Key(input.scope, 'previous'),
    liveLeagueV2Key(input.scope, 'sequence'),
    JSON.stringify(manifest),
    String(LIVE_LEAGUE_PREVIOUS_TTL_MS),
    String(input.state === 'FINALIZED' ? LIVE_LEAGUE_FINAL_TTL_MS : 0),
    currentRaw,
  )) as unknown;
  if (!Array.isArray(result) || typeof result[0] !== 'string')
    throw new CacheError('Invalid live league promotion result', 'LIVE_LEAGUE_PROMOTE_FAILED');
  const status = result[0];
  if (status === 'stale') {
    const stale = parseManifest(typeof result[1] === 'string' ? result[1] : null, input.scope);
    if (!stale)
      throw new CacheError(
        'Live league stale publication is invalid',
        'LIVE_LEAGUE_PROMOTE_FAILED',
      );
    return { publication: stale, previous: stale, published: false };
  }
  if (status === 'changed')
    throw new CacheError('Live league publication pointer changed', 'LIVE_LEAGUE_PROMOTE_CHANGED');
  if (status !== 'published')
    throw new CacheError(`Live league promotion failed: ${status}`, 'LIVE_LEAGUE_PROMOTE_FAILED');
  return {
    publication: manifest,
    previous: parseManifest(typeof result[1] === 'string' ? result[1] : null, input.scope),
    published: true,
  };
}

async function touchLiveLeaguePublicationV2(
  publication: LeagueLiveManifest,
  observedRaw: string,
  redis: Redis,
): Promise<LeagueLiveManifest | null> {
  const scope: LeagueLiveScope = {
    season: publication.season,
    eventId: publication.eventId,
    tournamentId: publication.tournamentId,
    scope: publication.scope,
    ...(publication.matchId === undefined ? {} : { matchId: publication.matchId }),
  };
  const result = (await redis.eval(
    TOUCH_LUA,
    1,
    liveLeagueV2Key(scope, 'active'),
    observedRaw,
    JSON.stringify(publication),
    String(LIVE_LEAGUE_FINAL_TTL_MS),
  )) as unknown;
  if (!Array.isArray(result) || result[0] !== 'touched' || typeof result[1] !== 'string')
    return null;
  return parseManifest(result[1], scope);
}

export async function touchLiveLeaguePublicationV2Heartbeat(
  publication: LeagueLiveManifest,
  sourceCheckedAt: Date | string,
  expectedNextCheckAt: Date | string | null,
  redisClient?: Redis,
): Promise<LeagueLiveManifest | null> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  const scope: LeagueLiveScope = {
    season: publication.season,
    eventId: publication.eventId,
    tournamentId: publication.tournamentId,
    scope: publication.scope,
    ...(publication.matchId === undefined ? {} : { matchId: publication.matchId }),
  };
  const currentRaw = (await redis.get(liveLeagueV2Key(scope, 'active'))) ?? '';
  if (currentRaw === '') return null;
  const next: LeagueLiveManifest = {
    ...publication,
    times: {
      ...publication.times,
      sourceCheckedAt: sourceDate(sourceCheckedAt),
      expectedNextCheckAt: expectedNextCheckAt === null ? null : sourceDate(expectedNextCheckAt),
    },
  };
  return touchLiveLeaguePublicationV2(next, currentRaw, redis);
}

async function readPointer(
  redis: Redis,
  scope: LeagueLiveScope,
  pointer: 'active' | 'previous',
): Promise<LeagueLiveRead | null> {
  try {
    const raw = await redis.get(liveLeagueV2Key(scope, pointer));
    const publication = parseManifest(raw, scope);
    if (!publication) return null;
    const values = await redis.mget(
      publication.items.index.key,
      metadataKey(publication.items.index.key),
      publication.items.payload.key,
      metadataKey(publication.items.payload.key),
    );
    const [indexPayload, indexMetadata, payload, payloadMetadata] = values;
    if (
      indexPayload === null ||
      payload === null ||
      indexMetadata !==
        `${publication.items.index.count}|${publication.items.index.bytes}|${publication.items.index.sha256}` ||
      payloadMetadata !==
        `${publication.items.payload.count}|${publication.items.payload.bytes}|${publication.items.payload.sha256}` ||
      Buffer.byteLength(indexPayload, 'utf8') !== publication.items.index.bytes ||
      Buffer.byteLength(payload, 'utf8') !== publication.items.payload.bytes ||
      hashSerializedPayload(indexPayload) !== publication.items.index.sha256 ||
      hashSerializedPayload(payload) !== publication.items.payload.sha256
    )
      return null;
    const index = JSON.parse(indexPayload) as unknown;
    const decodedPayload = JSON.parse(payload) as unknown;
    let validatedIndex: LeagueLiveIndex[];
    if (publication.scope === 'CLASSIC') {
      if (!validClassicPayload(index, decodedPayload, publication)) return null;
      validatedIndex = index;
    } else {
      if (!validH2HPayload(index, decodedPayload, publication)) return null;
      validatedIndex = index;
    }
    return {
      publication,
      index: validatedIndex,
      payload: decodedPayload as LeagueLivePayload,
      servedFrom: pointer === 'active' ? 'REDIS_CURRENT' : 'REDIS_PREVIOUS',
    };
  } catch {
    return null;
  }
}

export async function readLiveLeaguePublicationV2(
  scope: LeagueLiveScope,
  redisClient?: Redis,
): Promise<LeagueLiveRead | null> {
  assertScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  return (
    (await readPointer(redis, scope, 'active')) ?? (await readPointer(redis, scope, 'previous'))
  );
}

export async function readLiveLeaguePublicationV2Pointer(
  scope: LeagueLiveScope,
  pointer: 'active' | 'previous',
  redisClient?: Redis,
): Promise<LeagueLiveRead | null> {
  assertScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  return readPointer(redis, scope, pointer);
}

export async function markLiveLeaguePublicationCheckpointedV2(
  publication: LeagueLiveManifest,
  checkpointedAt: Date | string,
  redisClient?: Redis,
): Promise<LeagueLiveManifest | null> {
  const scope: LeagueLiveScope = {
    season: publication.season,
    eventId: publication.eventId,
    tournamentId: publication.tournamentId,
    scope: publication.scope,
    ...(publication.matchId === undefined ? {} : { matchId: publication.matchId }),
  };
  const redis = redisClient ?? (await redisSingleton.getClient());
  const result = (await redis.eval(
    CHECKPOINT_LUA,
    1,
    liveLeagueV2Key(scope, 'active'),
    publication.publicationId,
    String(publication.generation),
    sourceDate(checkpointedAt),
    String(LIVE_LEAGUE_FINAL_TTL_MS),
  )) as unknown;
  if (!Array.isArray(result) || result[0] !== 'checkpointed' || typeof result[1] !== 'string')
    return null;
  return parseManifest(result[1], scope);
}

export async function setLiveLeagueCheckpointDesiredV2(
  publication: LeagueLiveManifest,
  requestedAt: Date | string = new Date(),
  options: { readonly force?: boolean; readonly redis?: Redis } = {},
): Promise<LeagueLiveCheckpointDesired> {
  const scope: LeagueLiveScope = {
    season: publication.season,
    eventId: publication.eventId,
    tournamentId: publication.tournamentId,
    scope: publication.scope,
    ...(publication.matchId === undefined ? {} : { matchId: publication.matchId }),
  };
  const desired: LeagueLiveCheckpointDesired = {
    contractVersion: LIVE_LEAGUE_CONTRACT_VERSION,
    season: publication.season,
    eventId: publication.eventId,
    tournamentId: publication.tournamentId,
    scope: publication.scope,
    ...(publication.matchId === undefined ? {} : { matchId: publication.matchId }),
    publicationId: publication.publicationId,
    generation: publication.generation,
    requestedAt: sourceDate(requestedAt),
    force: options.force === true || publication.state === 'FINALIZED',
  };
  const redis = options.redis ?? (await redisSingleton.getClient());
  const result = (await redis.eval(
    SET_DESIRED_LUA,
    1,
    liveLeagueV2Key(scope, 'checkpoint-desired'),
    desired.publicationId,
    String(desired.generation),
    JSON.stringify(desired),
    String(7 * 24 * 60 * 60),
  )) as unknown;
  if (!Array.isArray(result) || typeof result[1] !== 'string')
    throw new CacheError(
      'Invalid live league checkpoint obligation',
      'LIVE_LEAGUE_CHECKPOINT_DESIRED_INVALID',
    );
  return JSON.parse(result[1]) as LeagueLiveCheckpointDesired;
}

export async function readLiveLeagueCheckpointDesiredV2(
  scope: LeagueLiveScope,
  redisClient?: Redis,
): Promise<LeagueLiveCheckpointDesired | null> {
  assertScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  const raw = await redis.get(liveLeagueV2Key(scope, 'checkpoint-desired'));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      value.contractVersion !== LIVE_LEAGUE_CONTRACT_VERSION ||
      value.season !== scope.season ||
      value.eventId !== scope.eventId ||
      value.tournamentId !== scope.tournamentId ||
      value.scope !== scope.scope ||
      (scope.scope === 'H2H_MATCH' && value.matchId !== scope.matchId) ||
      typeof value.publicationId !== 'string' ||
      typeof value.generation !== 'number' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation <= 0 ||
      !validIso(value.requestedAt) ||
      typeof value.force !== 'boolean'
    )
      return null;
    return value as unknown as LeagueLiveCheckpointDesired;
  } catch {
    return null;
  }
}

export async function clearLiveLeagueCheckpointDesiredV2(
  desired: LeagueLiveCheckpointDesired,
  redisClient?: Redis,
): Promise<boolean> {
  const scope: LeagueLiveScope = {
    season: desired.season,
    eventId: desired.eventId,
    tournamentId: desired.tournamentId,
    scope: desired.scope,
    ...(desired.matchId === undefined ? {} : { matchId: desired.matchId }),
  };
  const redis = redisClient ?? (await redisSingleton.getClient());
  return (
    Number(
      await redis.eval(
        CLEAR_DESIRED_LUA,
        1,
        liveLeagueV2Key(scope, 'checkpoint-desired'),
        desired.publicationId,
        String(desired.generation),
      ),
    ) === 1
  );
}

export type LiveLeagueEntryInput = {
  readonly publication: {
    readonly publicationId: string;
    readonly generation: number;
    readonly sourceCheckedAt: string;
  };
  readonly input: EntryLiveInputV2;
};

/** Background publisher helper; it intentionally never calls FPL. */
export async function readLiveLeagueEntryInputV2(
  season: string,
  eventId: number,
  entryId: number,
  redisClient?: Redis,
): Promise<LiveLeagueEntryInput | null> {
  const read = await readEntryLiveInputV2({ season, eventId, entryId }, redisClient);
  if (!read) return null;
  return {
    publication: {
      publicationId: read.publication.publicationId,
      generation: read.publication.generation,
      sourceCheckedAt: read.publication.sourceCheckedAt,
    },
    input: read.input,
  };
}

export function leagueEntryInputRevision(input: EntryLiveInputV2): string {
  return contentHash(input);
}
