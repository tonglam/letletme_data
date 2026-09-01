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
export type LeagueLiveAvailability = 'READY' | 'PENDING' | 'NO_PICKS' | 'MISSING' | 'ERROR';

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

export type LeagueLivePointerReadV2 = {
  readonly raw: string;
  readonly read: LeagueLiveRead | null;
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
  /** Earliest time a non-boundary checkpoint may be attempted. */
  readonly notBefore: string | null;
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
  for (const key of ['officialRank', 'schedule', 'averageSide'] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
    if (value[key] !== null && !validHash(value[key])) return false;
  }
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
    } else {
      if (row.startedEvent === null || row.startedEvent <= manifest.eventId) return false;
      if (input !== null) return false;
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
    typeof value.sourceOrder === 'number' &&
    Number.isSafeInteger(value.sourceOrder) &&
    value.sourceOrder >= 0 &&
    (value.phase === 'REGULAR' || value.phase === 'KNOCKOUT') &&
    (value.phase === 'KNOCKOUT' ? value.groupId >= 0 : value.groupId > 0) &&
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

function validH2HMatchSide(
  value: unknown,
  manifest: LeagueLiveManifest,
  isBye: boolean,
): value is H2HMatchSide {
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
      (value.isAverage === true ||
        (isBye && value.isAverage === false && value.entryName === 'Bye')) &&
      value.inputPublicationId === null &&
      value.inputGeneration === null &&
      value.inputRevision === null &&
      value.inputContentUpdatedAt === null &&
      value.input === null
    );
  }
  if (value.input === null) {
    return (
      value.isAverage === false &&
      value.inputPublicationId === null &&
      value.inputGeneration === null &&
      value.inputRevision === null &&
      value.inputContentUpdatedAt === null
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
    typeof value.sourceOrder === 'number' &&
    Number.isSafeInteger(value.sourceOrder) &&
    value.sourceOrder >= 0 &&
    (value.phase === 'REGULAR' || value.phase === 'KNOCKOUT') &&
    (value.phase === 'KNOCKOUT' ? value.groupId >= 0 : value.groupId > 0) &&
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
    validH2HMatchSide(value.home, manifest, value.isBye) &&
    validH2HMatchSide(value.away, manifest, value.isBye) &&
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
    standings.throughEventId !== manifest.eventId ||
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

function validFinalizedLeaguePayload(
  scope: LeagueLiveScope,
  index: unknown,
  payload: unknown,
  manifest: LeagueLiveManifest,
): boolean {
  if (scope.scope === 'CLASSIC') {
    if (!validClassicPayload(index, payload, manifest) || !isRecord(payload)) return false;
    return index.every((row) => {
      if (row.availability === 'NO_PICKS') return true;
      const input = payload[String(row.entryId)];
      return (
        validateEntryLiveInputV2(input, {
          season: manifest.season,
          eventId: manifest.eventId,
          entryId: row.entryId,
        }) && input.finalResult !== null
      );
    });
  }
  if (!validH2HPayload(index, payload, manifest) || !isRecord(payload)) return false;
  if (scope.scope === 'H2H_STANDINGS') {
    return isRecord(payload.standings) && payload.standings.state === 'READY';
  }
  return index.every((row) => {
    if (!validH2HMatchIndexRow(row) || !isRecord(payload[String(row.matchId)])) return false;
    const match = payload[String(row.matchId)];
    if (!validH2HMatchPayload(match, manifest) || match.state !== 'READY') return false;
    return [match.home, match.away].every(
      (side) => side.entryId === null || (side.input !== null && side.input.finalResult !== null),
    );
  });
}

/**
 * Validate the self-contained proof stored by the PostgreSQL league
 * checkpoint. A FINALIZED state column alone is not enough: serving also
 * depends on the manifest item descriptors, their checksums, and the
 * index/payload relationship.
 */
export function validateLiveLeaguePublicationV2Checkpoint(
  scope: LeagueLiveScope,
  manifest: unknown,
  index: unknown,
  payload: unknown,
  proof: Readonly<{
    readonly publicationId: string;
    readonly generation: number;
    readonly state: string;
    readonly rowCount: number;
    readonly payloadBytes: number;
    readonly payloadSha256: string;
  }>,
): boolean {
  try {
    if (!isRecord(manifest) || !isRecord(proof)) return false;
    const serializedManifest = JSON.stringify(manifest);
    if (typeof serializedManifest !== 'string') return false;
    const parsed = parseManifest(serializedManifest, scope);
    if (
      parsed === null ||
      parsed.state !== 'FINALIZED' ||
      parsed.times.checkpointedAt === null ||
      proof.state !== 'FINALIZED' ||
      proof.publicationId !== parsed.publicationId ||
      proof.generation !== parsed.generation ||
      !Number.isSafeInteger(proof.rowCount) ||
      proof.rowCount < 0 ||
      !Number.isSafeInteger(proof.payloadBytes) ||
      proof.payloadBytes < 0 ||
      !validHash(proof.payloadSha256)
    ) {
      return false;
    }
    const sourceCheckedAt = Date.parse(parsed.times.sourceCheckedAt);
    const publishedAt = Date.parse(parsed.times.publishedAt);
    const checkpointedAt = Date.parse(parsed.times.checkpointedAt);
    const contentUpdatedAt = Date.parse(parsed.times.contentUpdatedAt);
    if (
      !Number.isFinite(sourceCheckedAt) ||
      !Number.isFinite(contentUpdatedAt) ||
      !Number.isFinite(publishedAt) ||
      !Number.isFinite(checkpointedAt)
    ) {
      return false;
    }
    const indexPayload = canonicalJson(index);
    const valuePayload = canonicalJson(payload);
    const packed = { index, payload };
    if (
      proof.rowCount !== (Array.isArray(index) ? index.length : -1) ||
      proof.payloadBytes !== Buffer.byteLength(canonicalJson(packed), 'utf8') ||
      proof.payloadSha256 !== contentHash(packed) ||
      parsed.items.index.bytes !== Buffer.byteLength(indexPayload, 'utf8') ||
      parsed.items.payload.bytes !== Buffer.byteLength(valuePayload, 'utf8') ||
      parsed.items.index.sha256 !== contentHash(index) ||
      parsed.items.payload.sha256 !== contentHash(payload)
    ) {
      return false;
    }
    return validFinalizedLeaguePayload(scope, index, payload, parsed);
  } catch {
    return false;
  }
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

function assertRowBytes(
  scope: LeagueLiveScope,
  index: readonly LeagueLiveIndex[],
  payload: LeagueLivePayload,
): void {
  const assertWithinLimit = (name: string, value: unknown): void => {
    const bytes = Buffer.byteLength(canonicalJson(value), 'utf8');
    if (bytes > LIVE_LEAGUE_MAX_ROW_BYTES) {
      throw new CacheError(
        `Live league ${name} exceeds row limit`,
        'LIVE_LEAGUE_ROW_LIMIT_EXCEEDED',
      );
    }
  };
  index.forEach((row, rowIndex) => assertWithinLimit(`index row ${rowIndex}`, row));
  if (scope.scope === 'H2H_STANDINGS') {
    const standings = payload.standings;
    if (isRecord(standings) && Array.isArray(standings.rows)) {
      standings.rows.forEach((row, rowIndex) =>
        assertWithinLimit(`standings row ${rowIndex}`, row),
      );
    }
    return;
  }
  Object.entries(payload).forEach(([key, value]) => assertWithinLimit(`payload row ${key}`, value));
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
local currentHealthy = ARGV[5] == '1'
local currentRaw = redis.call('GET', KEYS[1]) or ''
if currentRaw ~= observed then return {'changed', currentRaw} end
local scopePrefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - string.len(':active'))
if candidate.contractVersion ~= 'live-points-v2' or not candidate.items or type(candidate.generation) ~= 'number' or candidate.generation <= 0 then return {'invalid_candidate'} end
local function validItem(item, name, generation)
  return item and item.name == name and item.type == 'string' and type(item.key) == 'string' and item.key == scopePrefix .. ':' .. tostring(generation) .. ':' .. name and type(item.count) == 'number' and item.count >= 0 and type(item.bytes) == 'number' and item.bytes >= 0 and type(item.sha256) == 'string' and string.len(item.sha256) == 64
end
for _, name in ipairs({'index', 'payload'}) do
  local descriptor = candidate.items[name]
  if not validItem(descriptor, name, candidate.generation) then return {'invalid_item'} end
  if redis.call('EXISTS', descriptor.key) ~= 1 then return {'missing_stage', descriptor.key} end
  local itemType = redis.call('TYPE', descriptor.key)
  local actualType = type(itemType) == 'table' and itemType['ok'] or itemType
  if actualType ~= 'string' or redis.call('STRLEN', descriptor.key) ~= descriptor.bytes or redis.call('GET', descriptor.key .. ':meta') ~= tostring(descriptor.count) .. '|' .. tostring(descriptor.bytes) .. '|' .. descriptor.sha256 then return {'invalid_stage', descriptor.key} end
end
local current = nil
if currentHealthy and currentRaw ~= '' then
  local ok, decoded = pcall(cjson.decode, currentRaw)
  if ok and decoded.contractVersion == 'live-points-v2' and type(decoded.generation) == 'number' then current = decoded end
end
if current and current.generation >= candidate.generation then return {'stale', currentRaw} end
if current and current.state == 'FINALIZED' then return {'stale', currentRaw} end
if current and currentHealthy then
  redis.call('SET', KEYS[2], currentRaw, 'PX', ARGV[2])
  for _, name in ipairs({'index', 'payload'}) do
    local old = current.items and current.items[name]
    local expectedOldKey = scopePrefix .. ':' .. tostring(current.generation) .. ':' .. name
    if old and old.name == name and old.type == 'string' and old.key == expectedOldKey then
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
local scopePrefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - string.len(':active'))
local function validItem(item, name)
  return item and item.name == name and item.type == 'string' and item.key == scopePrefix .. ':' .. tostring(next.generation) .. ':' .. name
end
for _, name in ipairs({'index', 'payload'}) do
  if not validItem(next.items and next.items[name], name) then return {'invalid'} end
end
redis.call('SET', KEYS[1], ARGV[2])
if next.state == 'FINALIZED' then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  for _, name in ipairs({'index', 'payload'}) do
    local item = next.items[name]
    redis.call('PEXPIRE', item.key, ARGV[3])
    redis.call('PEXPIRE', item.key .. ':meta', ARGV[3])
  end
else
  redis.call('PERSIST', KEYS[1])
end
return {'touched', ARGV[2]}
`;

const CHECKPOINT_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) then return {'changed'} end
value.times.checkpointedAt = ARGV[3]
local scopePrefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - string.len(':active'))
local function validItem(item, name)
  return item and item.name == name and item.type == 'string' and item.key == scopePrefix .. ':' .. tostring(value.generation) .. ':' .. name
end
if value.state == 'FINALIZED' then
  for _, name in ipairs({'index', 'payload'}) do
    if not validItem(value.items and value.items[name], name) then return {'invalid'} end
  end
end
redis.call('SET', KEYS[1], cjson.encode(value))
if value.state == 'FINALIZED' then
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
  for _, name in ipairs({'index', 'payload'}) do
    local item = value.items[name]
    redis.call('PEXPIRE', item.key, ARGV[4])
    redis.call('PEXPIRE', item.key .. ':meta', ARGV[4])
  end
else
  redis.call('PERSIST', KEYS[1])
end
return {'checkpointed', cjson.encode(value)}
`;

const SET_DESIRED_LUA = `
local existingRaw = redis.call('GET', KEYS[1])
local desired = cjson.decode(ARGV[3])
local expectedEventId = tonumber(ARGV[6])
local expectedTournamentId = tonumber(ARGV[7])
local expectedMatchId = tonumber(ARGV[9])
local function validUuid(value)
  return type(value) == 'string' and string.len(value) == 36 and string.match(value, '^[0-9a-fA-F%-]+$') ~= nil
end
local function validIso(value)
  return type(value) == 'string' and string.match(value, '^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$') ~= nil
end
local function validExisting(value)
  if type(value) ~= 'table' or
     value.contractVersion ~= ARGV[10] or
     value.season ~= ARGV[5] or
     value.eventId ~= expectedEventId or
     value.tournamentId ~= expectedTournamentId or
     value.scope ~= ARGV[8] or
     not validUuid(value.publicationId) or
     type(value.generation) ~= 'number' or
     value.generation <= 0 or
     value.generation > 9007199254740991 or
     value.generation ~= math.floor(value.generation) or
     not validIso(value.requestedAt) or
     (value.notBefore ~= cjson.null and not validIso(value.notBefore)) or
     type(value.force) ~= 'boolean' then
    return false
  end
  if ARGV[8] == 'H2H_MATCH' then
    return type(value.matchId) == 'number' and
      value.matchId == expectedMatchId and
      value.matchId > 0 and
      value.matchId <= 9007199254740991 and
      value.matchId == math.floor(value.matchId)
  end
  return value.matchId == nil
end
if existingRaw then
  local ok, existing = pcall(cjson.decode, existingRaw)
  if ok and validExisting(existing) then
    local generation = tonumber(ARGV[2])
    if existing.generation > generation or (existing.generation == generation and existing.publicationId ~= ARGV[1]) then return {'kept', existingRaw} end
    if desired.force ~= true and existing.force == true then desired.force = true end
    if desired.force ~= true and desired.notBefore == cjson.null and type(existing.notBefore) == 'string' then desired.notBefore = existing.notBefore end
  end
end
if desired.force == true then desired.notBefore = cjson.null end
local encoded = cjson.encode(desired)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[4])
return {'set', encoded}
`;

const CLEAR_DESIRED_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) then return 0 end
return redis.call('DEL', KEYS[1])
`;

/**
 * Remove one exact tournament/event publication after its owner leaves the
 * active set.  The pointer values are read immediately before this CAS-like
 * Lua call; a concurrent reactivation therefore wins instead of being
 * deleted by retirement.  The sequence key is deliberately retained so a
 * later reactivation cannot reuse an old generation.
 */
const RETIRE_LUA = `
local active = redis.call('GET', KEYS[1]) or ''
local previous = redis.call('GET', KEYS[2]) or ''
if active ~= ARGV[1] or previous ~= ARGV[2] then return {'changed'} end
local scopePrefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - string.len(':active'))
local function removeItems(raw)
  if raw == '' then return end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' or type(value.items) ~= 'table' then return end
  for _, name in ipairs({'index', 'payload'}) do
    local item = value.items[name]
    if type(item) == 'table' and type(item.key) == 'string' and
       string.sub(item.key, 1, string.len(scopePrefix) + 1) == scopePrefix .. ':' then
      redis.call('UNLINK', item.key, item.key .. ':meta')
    end
  end
end
removeItems(active)
removeItems(previous)
redis.call('UNLINK', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
return {'retired'}
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
  /** Optional prevalidated pointer reads supplied by a batched publisher. */
  readonly currentRead?: LeagueLiveRead | null;
  readonly previousRead?: LeagueLiveRead | null;
  /** Raw pointer values supplied with batched reads so promotion needs no second MGET. */
  readonly currentPointerRaw?: string;
  readonly previousPointerRaw?: string;
  readonly generationFloor?: number;
  /** Loaded only when both Redis pointers are missing or corrupt. */
  readonly generationFloorLoader?: () => Promise<number>;
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
  assertRowBytes(input.scope, input.index, input.payload);
  const redis = input.redis ?? (await redisSingleton.getClient());
  let currentRaw: string;
  let previousRaw: string;
  if (input.currentPointerRaw !== undefined && input.previousPointerRaw !== undefined) {
    currentRaw = input.currentPointerRaw;
    previousRaw = input.previousPointerRaw;
  } else {
    const pointerRaws = await redis.mget(
      liveLeagueV2Key(input.scope, 'active'),
      liveLeagueV2Key(input.scope, 'previous'),
    );
    currentRaw = pointerRaws[0] ?? '';
    previousRaw = pointerRaws[1] ?? '';
  }
  const currentPointer = parseManifest(currentRaw, input.scope);
  const previousPointer = parseManifest(previousRaw, input.scope);
  const currentRead =
    input.currentRead === undefined
      ? await readPointer(redis, input.scope, 'active')
      : input.currentRead;
  const previousRead =
    input.previousRead === undefined
      ? await readPointer(redis, input.scope, 'previous')
      : input.previousRead;
  const current = currentRead?.publication ?? null;
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
    Math.max(
      input.generationFloor ?? 0,
      input.previous?.generation ?? 0,
      previousPointer?.generation ?? 0,
      currentPointer?.generation ?? 0,
      current?.generation ?? 0,
      !currentRead && !previousRead && input.generationFloorLoader
        ? await input.generationFloorLoader()
        : 0,
    ),
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
    currentRead ? '1' : '0',
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
    previous: currentRead?.publication ?? null,
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

function decodePointerRead(
  scope: LeagueLiveScope,
  pointer: 'active' | 'previous',
  raw: string | null,
  values: readonly (string | null)[],
): LeagueLiveRead | null {
  try {
    const publication = parseManifest(raw, scope);
    if (!publication) return null;
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
    return decodePointerRead(scope, pointer, raw, values);
  } catch {
    return null;
  }
}

/**
 * Reads many sibling publications with one pointer MGET and one item MGET.
 * League publishers use this to avoid one Redis round trip per H2H match.
 * A corrupt pointer or item set is omitted rather than returned as a partial
 * publication; callers can then retain an independently validated previous
 * match or fail that exact scope.
 */
export async function readLiveLeaguePublicationV2PointersV2(
  scopes: readonly LeagueLiveScope[],
  pointer: 'active' | 'previous',
  redisClient?: Redis,
): Promise<ReadonlyMap<string, LeagueLivePointerReadV2>> {
  for (const scope of scopes) assertScope(scope);
  const uniqueScopes = [
    ...new Map(scopes.map((scope) => [liveLeagueV2Key(scope, pointer), scope])).values(),
  ];
  if (uniqueScopes.length === 0) return new Map();
  const redis = redisClient ?? (await redisSingleton.getClient());
  const pointerKeys = uniqueScopes.map((scope) => liveLeagueV2Key(scope, pointer));
  const pointerRaws = await redis.mget(...pointerKeys);
  const reads = new Map<string, LeagueLivePointerReadV2>(
    uniqueScopes.map((scope, index) => [
      pointerKeys[index],
      { raw: pointerRaws[index] ?? '', read: null },
    ]),
  );
  const candidates = uniqueScopes.flatMap((scope, index) => {
    const raw = pointerRaws[index];
    const publication = parseManifest(raw, scope);
    return publication ? [{ scope, key: pointerKeys[index], raw, publication }] : [];
  });
  if (candidates.length === 0) return reads;
  const itemKeys = candidates.flatMap(({ publication }) => [
    publication.items.index.key,
    metadataKey(publication.items.index.key),
    publication.items.payload.key,
    metadataKey(publication.items.payload.key),
  ]);
  const itemValues = await redis.mget(...itemKeys);
  for (const [index, candidate] of candidates.entries()) {
    const read = decodePointerRead(
      candidate.scope,
      pointer,
      candidate.raw,
      itemValues.slice(index * 4, index * 4 + 4),
    );
    reads.set(candidate.key, { raw: candidate.raw ?? '', read });
  }
  return reads;
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
  options: {
    readonly force?: boolean;
    readonly notBefore?: Date | string | null;
    readonly redis?: Redis;
  } = {},
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
    notBefore:
      options.notBefore === undefined || options.notBefore === null
        ? null
        : sourceDate(options.notBefore),
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
    desired.season,
    String(desired.eventId),
    String(desired.tournamentId),
    desired.scope,
    desired.matchId === undefined ? '' : String(desired.matchId),
    desired.contractVersion,
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
      (value.notBefore !== null && !validIso(value.notBefore)) ||
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

export async function retireLiveLeaguePublicationV2(
  scope: LeagueLiveScope,
  redisClient?: Redis,
): Promise<boolean> {
  assertScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  const activeKey = liveLeagueV2Key(scope, 'active');
  const previousKey = liveLeagueV2Key(scope, 'previous');
  const [activeRaw, previousRaw] = await redis.mget(activeKey, previousKey);
  const result = (await redis.eval(
    RETIRE_LUA,
    4,
    activeKey,
    previousKey,
    liveLeagueV2Key(scope, 'desired'),
    liveLeagueV2Key(scope, 'checkpoint-desired'),
    activeRaw ?? '',
    previousRaw ?? '',
  )) as unknown;
  return Array.isArray(result) && result[0] === 'retired';
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
