import { createHash, randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

import type { EventLive } from '../domain/event-lives';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { Fixture, RawFPLEntryEventPicksResponse } from '../types';
import { canonicalJson, contentHash } from '../utils/content-hash';
import { CacheError } from '../utils/errors';
import { redisSingleton } from './singleton';

/**
 * Live Points V2 is intentionally a separate namespace.  Nothing in this
 * module calls the V1 publication reader or writer; a cutover can therefore
 * prove that a service is really using the new contract by inspecting Redis
 * keys alone.
 */
export const LIVE_POINTS_CONTRACT_VERSION = 'live-points-v2' as const;
export const LIVE_PUBLICATION_PREVIOUS_TTL_MS = 24 * 60 * 60_000;
export const LIVE_PUBLICATION_FINAL_TTL_MS = 48 * 60 * 60_000;
const STAGING_TTL_MS = 15 * 60_000;

export type LivePublicationState =
  | 'PRE_DEADLINE'
  | 'PICKS_WAIT'
  | 'PICKS_PROBE'
  | 'PICKS_SYNC'
  | 'LIVE_ACTIVE'
  | 'BETWEEN_FIXTURES'
  | 'DAY_SETTLING'
  | 'GW_REVIEW'
  | 'FINALIZED';

export interface StreamRevision {
  readonly revision: string;
  readonly contentUpdatedAt: string;
}

export interface PublicationItem {
  readonly name: string;
  readonly key: string;
  readonly type: 'string';
  readonly count: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LivePublicationV2 {
  readonly contractVersion: typeof LIVE_POINTS_CONTRACT_VERSION;
  readonly publicationId: string;
  readonly generation: number;
  readonly season: string;
  readonly eventId: number;
  readonly state: LivePublicationState;
  readonly sourceCheckedAt: string;
  readonly publishedAt: string;
  readonly checkpointedAt: string | null;
  readonly expectedNextCheckAt: string | null;
  readonly revisions: {
    readonly lifecycle: StreamRevision;
    readonly fixtureIdentity: StreamRevision;
    readonly scoreCore: StreamRevision;
    readonly displayStats: StreamRevision;
    readonly explain: StreamRevision;
    readonly rules: StreamRevision;
  };
  readonly items: {
    readonly eventLive: PublicationItem;
    readonly fixtures: PublicationItem;
  };
}

export interface LivePublicationRead {
  readonly publication: LivePublicationV2;
  readonly eventLives: readonly EventLive[];
  readonly fixtures: readonly Fixture[];
  readonly servedFrom: 'REDIS_CURRENT' | 'REDIS_PREVIOUS' | 'POSTGRES_CHECKPOINT';
}

export interface Exactly15Pick {
  readonly element: number;
  readonly position: number;
  readonly multiplier: number;
  readonly isCaptain: boolean;
  readonly isViceCaptain: boolean;
}

export type Exactly15Picks = readonly [
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
  Exactly15Pick,
];

export interface OfficialMultiplier {
  readonly element: number;
  readonly multiplier: number;
}

export interface OfficialSubstitution {
  readonly inElement: number;
  readonly outElement: number;
}

export interface FinalScore {
  readonly eventPoints: number;
  readonly totalPoints: number | null;
}

export interface EntryLiveInputV2 {
  readonly contractVersion: typeof LIVE_POINTS_CONTRACT_VERSION;
  readonly season: string;
  readonly eventId: number;
  readonly entryId: number;
  readonly picksBase: {
    readonly revision: string;
    readonly contentUpdatedAt: string;
    readonly picks: Exactly15Picks;
    readonly chip: string | null;
    readonly transferCost: number;
  };
  readonly previousTotals: {
    readonly revision: string;
    readonly throughEventId: number;
    readonly totalPoints: number;
    readonly overallRank: number | null;
  } | null;
  readonly officialAdjustment: {
    readonly revision: string;
    readonly multipliers: readonly OfficialMultiplier[];
    readonly automaticSubs: readonly OfficialSubstitution[];
  } | null;
  readonly finalResult: {
    readonly revision: string;
    readonly score: FinalScore;
    readonly picks: Exactly15Picks;
    readonly automaticSubs: readonly OfficialSubstitution[];
  } | null;
}

export interface EntryLivePublicationV2 {
  readonly contractVersion: typeof LIVE_POINTS_CONTRACT_VERSION;
  readonly publicationId: string;
  readonly generation: number;
  readonly season: string;
  readonly eventId: number;
  readonly entryId: number;
  readonly state: 'PROVISIONAL' | 'FINAL';
  readonly sourceCheckedAt: string;
  readonly publishedAt: string;
  readonly checkpointedAt: string | null;
  readonly expectedNextCheckAt: string | null;
  readonly item: PublicationItem;
}

export interface EntryLivePublicationRead {
  readonly publication: EntryLivePublicationV2;
  readonly input: EntryLiveInputV2;
  readonly servedFrom: 'REDIS_CURRENT' | 'REDIS_PREVIOUS';
}

type LiveScope = { readonly season: string; readonly eventId: number };
type EntryScope = LiveScope & { readonly entryId: number };

function assertSeasonEvent(scope: LiveScope): void {
  if (!/^\d{4}$/.test(scope.season)) {
    throw new CacheError('Invalid V2 publication season', 'LIVE_V2_SEASON_INVALID');
  }
  if (!Number.isSafeInteger(scope.eventId) || scope.eventId <= 0) {
    throw new CacheError('Invalid V2 publication event', 'LIVE_V2_EVENT_INVALID');
  }
}

function assertEntryScope(scope: EntryScope): void {
  assertSeasonEvent(scope);
  if (!Number.isSafeInteger(scope.entryId) || scope.entryId <= 0) {
    throw new CacheError('Invalid V2 entry', 'LIVE_V2_ENTRY_INVALID');
  }
}

export function liveV2Key(scope: LiveScope, suffix: 'active' | 'previous' | 'sequence'): string {
  assertSeasonEvent(scope);
  return `llm:data:v2:fpl:live:${scope.season}:${scope.eventId}:${suffix}`;
}

/** Shared scheduler state. It is deliberately scoped beside the publication. */
export function liveV2LifecycleKey(scope: LiveScope): string {
  assertSeasonEvent(scope);
  return `llm:data:v2:fpl:live:${scope.season}:${scope.eventId}:lifecycle`;
}

/** One merged desired checkpoint per live scope; never a 30-second job pile. */
export function liveV2CheckpointDesiredKey(scope: LiveScope): string {
  assertSeasonEvent(scope);
  return `llm:data:v2:fpl:live:${scope.season}:${scope.eventId}:checkpoint-desired`;
}

/** Shared entry-picks coordinator state survives scheduler restarts. */
export function liveV2PicksCoordinatorKey(scope: LiveScope): string {
  assertSeasonEvent(scope);
  return `llm:data:v2:fpl:live:${scope.season}:${scope.eventId}:picks-coordinator`;
}

/** Entry ids still waiting for the one-time live picks base-input fetch. */
export function liveV2PicksPendingKey(scope: LiveScope): string {
  assertSeasonEvent(scope);
  return `llm:data:v2:fpl:live:${scope.season}:${scope.eventId}:picks-pending`;
}

/** Marker distinguishing an initialized empty cohort from a missing state. */
export function liveV2PicksCoverageKey(scope: LiveScope): string {
  assertSeasonEvent(scope);
  return `llm:data:v2:fpl:live:${scope.season}:${scope.eventId}:picks-coverage`;
}

export function liveV2ItemKey(
  scope: LiveScope,
  generation: number,
  name: 'eventLive' | 'fixtures',
): string {
  assertSeasonEvent(scope);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new CacheError('Invalid V2 generation', 'LIVE_V2_GENERATION_INVALID');
  }
  return `llm:data:v2:fpl:live:${scope.season}:${scope.eventId}:${generation}:${name}`;
}

/**
 * Staging metadata is kept beside each immutable payload.  Redis Lua cannot
 * calculate SHA-256, so promotion validates this atomically written tuple
 * against the manifest while the application validates the actual bytes
 * before entering the script.  A payload mutation between those two checks
 * therefore fails closed instead of becoming current.
 */
function itemMetadataKey(itemKey: string): string {
  return `${itemKey}:meta`;
}

export function entryLiveV2Key(
  scope: EntryScope,
  suffix: 'active' | 'previous' | 'sequence',
): string {
  assertEntryScope(scope);
  return `llm:data:v2:fpl:entry-live:${scope.season}:${scope.eventId}:${scope.entryId}:${suffix}`;
}

export function entryLiveV2ItemKey(scope: EntryScope, generation: number): string {
  assertEntryScope(scope);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new CacheError('Invalid V2 generation', 'LIVE_V2_GENERATION_INVALID');
  }
  return `llm:data:v2:fpl:entry-live:${scope.season}:${scope.eventId}:${scope.entryId}:${generation}:input`;
}

export interface EntryLiveCheckpointDesiredV2 {
  readonly contractVersion: typeof LIVE_POINTS_CONTRACT_VERSION;
  readonly season: string;
  readonly eventId: number;
  readonly entryId: number;
  readonly publicationId: string;
  readonly generation: number;
  readonly sourceCheckedAt: string;
  readonly requestedAt: string;
}

export function entryLiveV2CheckpointDesiredKey(scope: EntryScope): string {
  assertEntryScope(scope);
  return `llm:data:v2:fpl:entry-live:${scope.season}:${scope.eventId}:${scope.entryId}:checkpoint-desired`;
}

function itemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') return Object.keys(value).length;
  return value === null || value === undefined ? 0 : 1;
}

function publicationItemCount(name: PublicationItem['name'], value: unknown): number {
  if (name === 'input' && isRecord(value) && isRecord(value.picksBase)) {
    return Array.isArray(value.picksBase.picks) ? value.picksBase.picks.length : -1;
  }
  return itemCount(value);
}

function sha256(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validRevision(value: unknown): value is StreamRevision {
  return (
    isRecord(value) &&
    typeof value.revision === 'string' &&
    /^[0-9a-f]{64}$/.test(value.revision) &&
    validIso(value.contentUpdatedAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validItem(value: unknown, expectedKey: string): value is PublicationItem {
  return (
    isRecord(value) &&
    (value.name === 'eventLive' || value.name === 'fixtures' || value.name === 'input') &&
    value.key === expectedKey &&
    value.type === 'string' &&
    typeof value.count === 'number' &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

function parseLiveManifest(raw: string | null, scope: LiveScope): LivePublicationV2 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
      typeof value.publicationId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.publicationId) ||
      typeof value.generation !== 'number' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation <= 0 ||
      value.season !== scope.season ||
      value.eventId !== scope.eventId ||
      !(
        value.state === 'PRE_DEADLINE' ||
        value.state === 'PICKS_WAIT' ||
        value.state === 'PICKS_PROBE' ||
        value.state === 'PICKS_SYNC' ||
        value.state === 'LIVE_ACTIVE' ||
        value.state === 'BETWEEN_FIXTURES' ||
        value.state === 'DAY_SETTLING' ||
        value.state === 'GW_REVIEW' ||
        value.state === 'FINALIZED'
      ) ||
      !validIso(value.sourceCheckedAt) ||
      !validIso(value.publishedAt) ||
      (value.checkpointedAt !== null && !validIso(value.checkpointedAt)) ||
      (value.expectedNextCheckAt !== null && !validIso(value.expectedNextCheckAt)) ||
      !isRecord(value.revisions) ||
      !validRevision(value.revisions.lifecycle) ||
      !validRevision(value.revisions.fixtureIdentity) ||
      !validRevision(value.revisions.scoreCore) ||
      !validRevision(value.revisions.displayStats) ||
      !validRevision(value.revisions.explain) ||
      !validRevision(value.revisions.rules) ||
      !isRecord(value.items)
    ) {
      return null;
    }
    const items = value.items as Record<string, unknown>;
    const eventLiveKey = liveV2ItemKey(scope, value.generation, 'eventLive');
    const fixturesKey = liveV2ItemKey(scope, value.generation, 'fixtures');
    if (
      !validItem(items.eventLive, eventLiveKey) ||
      items.eventLive.name !== 'eventLive' ||
      !validItem(items.fixtures, fixturesKey) ||
      items.fixtures.name !== 'fixtures'
    ) {
      return null;
    }
    return value as unknown as LivePublicationV2;
  } catch {
    return null;
  }
}

function parseEntryManifest(raw: string | null, scope: EntryScope): EntryLivePublicationV2 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
      typeof value.publicationId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.publicationId) ||
      typeof value.generation !== 'number' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation <= 0 ||
      value.season !== scope.season ||
      value.eventId !== scope.eventId ||
      value.entryId !== scope.entryId ||
      (value.state !== 'PROVISIONAL' && value.state !== 'FINAL') ||
      !validIso(value.sourceCheckedAt) ||
      !validIso(value.publishedAt) ||
      (value.checkpointedAt !== null && !validIso(value.checkpointedAt)) ||
      (value.expectedNextCheckAt !== null && !validIso(value.expectedNextCheckAt)) ||
      !isRecord(value.item) ||
      value.item.name !== 'input' ||
      !validItem(value.item, entryLiveV2ItemKey(scope, value.generation))
    ) {
      return null;
    }
    return value as unknown as EntryLivePublicationV2;
  } catch {
    return null;
  }
}

function parseExactly15Picks(value: unknown): value is Exactly15Picks {
  if (!Array.isArray(value) || value.length !== 15) return false;
  const positions = new Set<number>();
  const elements = new Set<number>();
  let captains = 0;
  let viceCaptains = 0;
  for (const pick of value) {
    if (
      !isRecord(pick) ||
      typeof pick.element !== 'number' ||
      !Number.isSafeInteger(pick.element) ||
      pick.element <= 0 ||
      typeof pick.position !== 'number' ||
      !Number.isSafeInteger(pick.position) ||
      pick.position < 1 ||
      pick.position > 15 ||
      positions.has(pick.position) ||
      elements.has(pick.element) ||
      typeof pick.multiplier !== 'number' ||
      !Number.isSafeInteger(pick.multiplier) ||
      pick.multiplier < 0 ||
      pick.multiplier > 3 ||
      typeof pick.isCaptain !== 'boolean' ||
      typeof pick.isViceCaptain !== 'boolean' ||
      (pick.isCaptain && pick.isViceCaptain)
    ) {
      return false;
    }
    positions.add(pick.position);
    elements.add(pick.element);
    if (pick.isCaptain) captains += 1;
    if (pick.isViceCaptain) viceCaptains += 1;
  }
  return positions.size === 15 && captains === 1 && viceCaptains === 1;
}

export function validateEntryLiveInputV2(
  value: unknown,
  scope: EntryScope,
): value is EntryLiveInputV2 {
  if (!isRecord(value)) return false;
  const picksBase = value.picksBase;
  if (
    value.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
    value.season !== scope.season ||
    value.eventId !== scope.eventId ||
    value.entryId !== scope.entryId ||
    !isRecord(picksBase) ||
    typeof picksBase.revision !== 'string' ||
    !/^[0-9a-f]{64}$/.test(picksBase.revision) ||
    !validIso(picksBase.contentUpdatedAt) ||
    !parseExactly15Picks(picksBase.picks) ||
    (picksBase.chip !== null && typeof picksBase.chip !== 'string') ||
    typeof picksBase.transferCost !== 'number' ||
    !Number.isSafeInteger(picksBase.transferCost) ||
    picksBase.transferCost < 0
  ) {
    return false;
  }
  for (const field of ['previousTotals', 'officialAdjustment', 'finalResult'] as const) {
    const item = value[field];
    if (item === null) continue;
    if (
      !isRecord(item) ||
      typeof item.revision !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.revision)
    ) {
      return false;
    }
  }
  return true;
}

function contentUpdatedAt(
  previous: StreamRevision | undefined,
  revision: string,
  now: string,
): StreamRevision {
  return previous?.revision === revision ? previous : { revision, contentUpdatedAt: now };
}

function buildItem(
  scope: LiveScope,
  generation: number,
  name: 'eventLive' | 'fixtures',
  value: unknown,
): { readonly manifest: PublicationItem; readonly payload: string } {
  const payload = canonicalJson(value);
  return {
    manifest: {
      name,
      key: liveV2ItemKey(scope, generation, name),
      type: 'string',
      count: itemCount(value),
      bytes: Buffer.byteLength(payload, 'utf8'),
      sha256: sha256(payload),
    },
    payload,
  };
}

function buildEntryItem(
  scope: EntryScope,
  generation: number,
  input: EntryLiveInputV2,
): { readonly manifest: PublicationItem; readonly payload: string } {
  const payload = canonicalJson(input);
  return {
    manifest: {
      name: 'input',
      key: entryLiveV2ItemKey(scope, generation),
      type: 'string',
      count: itemCount(input.picksBase.picks),
      bytes: Buffer.byteLength(payload, 'utf8'),
      sha256: sha256(payload),
    },
    payload,
  };
}

const ALLOCATE_GENERATION_SCRIPT = `
local value = redis.call('INCR', KEYS[1])
local now = redis.call('TIME')
return {tostring(value), tostring(now[1]), tostring(now[2])}
`;

const PROMOTE_LIVE_SCRIPT = `
local candidate = cjson.decode(ARGV[1])
local current_raw = redis.call('GET', KEYS[1])
local current_generation = nil
local current_publication_id = nil
local current_scope_valid = false
local current_scope_mismatch = false
local current_state = nil
local current = nil
if current_raw then
  local ok, decoded = pcall(cjson.decode, current_raw)
  if ok and decoded.contractVersion == 'live-points-v2' then
    if decoded.season ~= candidate.season or decoded.eventId ~= candidate.eventId then
      current_scope_mismatch = true
    elseif type(decoded.generation) == 'number' and decoded.generation > 0 then
      current_generation = decoded.generation
      current_publication_id = decoded.publicationId
      current_scope_valid = true
      current_state = decoded.state
    end
  end
  if ok and decoded.items and decoded.contractVersion == 'live-points-v2' then
    local valid_current = true
    for _, name in ipairs({'eventLive', 'fixtures'}) do
      local item = decoded.items[name]
      local type_result = item and redis.call('TYPE', item.key) or ''
      local actual_type = type(type_result) == 'table' and type_result['ok'] or type_result
      if not item or item.type ~= 'string' or actual_type ~= 'string' or redis.call('EXISTS', item.key) ~= 1 or redis.call('STRLEN', item.key) ~= item.bytes or item.count == nil or item.count < 0 or item.sha256 == nil or redis.call('GET', item.key .. ':meta') ~= tostring(item.count) .. '|' .. tostring(item.bytes) .. '|' .. item.sha256 then
        valid_current = false
      end
    end
    if valid_current then current = decoded end
  end
end
if candidate.contractVersion ~= 'live-points-v2' or not candidate.items then return {'invalid_candidate'} end
if current_scope_mismatch then return {'scope_mismatch'} end
local same_identity = current_generation ~= nil and current_generation == candidate.generation and current_publication_id == candidate.publicationId
if current_generation then
  if current_generation > candidate.generation or (current_generation == candidate.generation and not same_identity) then return {'stale', current_raw} end
end
if current_state == 'FINALIZED' and not same_identity then return {'stale', current_raw} end
for _, name in ipairs({'eventLive', 'fixtures'}) do
  local item = candidate.items[name]
  if not item or not item.key or item.type ~= 'string' then return {'invalid_item'} end
  if redis.call('EXISTS', item.key) ~= 1 then return {'missing_stage', item.key} end
  local type_result = redis.call('TYPE', item.key)
  local actual_type = type(type_result) == 'table' and type_result['ok'] or type_result
  if actual_type ~= 'string' then return {'wrong_stage_type', item.key} end
  if redis.call('STRLEN', item.key) ~= item.bytes or redis.call('GET', item.key .. ':meta') ~= tostring(item.count) .. '|' .. tostring(item.bytes) .. '|' .. item.sha256 then return {'wrong_stage_metadata', item.key} end
end
if current then
  if not same_identity then
    redis.call('SET', KEYS[2], current_raw, 'PX', ARGV[2])
    for _, name in ipairs({'eventLive', 'fixtures'}) do
      local item = current.items[name]
      if redis.call('EXISTS', item.key) == 1 then
        redis.call('PEXPIRE', item.key, ARGV[2])
        redis.call('PEXPIRE', item.key .. ':meta', ARGV[2])
      end
    end
  end
end
for _, name in ipairs({'eventLive', 'fixtures'}) do
  if candidate.state == 'FINALIZED' then
    redis.call('PEXPIRE', candidate.items[name].key, ARGV[3])
    redis.call('PEXPIRE', candidate.items[name].key .. ':meta', ARGV[3])
  else
    redis.call('PERSIST', candidate.items[name].key)
    redis.call('PERSIST', candidate.items[name].key .. ':meta')
  end
end
redis.call('SET', KEYS[1], ARGV[1])
if candidate.state == 'FINALIZED' then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
else
  redis.call('PERSIST', KEYS[1])
end
local sequence = tonumber(redis.call('GET', KEYS[3]) or '0')
if sequence < candidate.generation then redis.call('SET', KEYS[3], tostring(candidate.generation)) end
return {'published', current_raw or ''}
`;

const PROMOTE_ENTRY_SCRIPT = `
local candidate = cjson.decode(ARGV[1])
local current_raw = redis.call('GET', KEYS[1])
local current_generation = nil
local current_scope_valid = false
local current_scope_mismatch = false
local current_state = nil
local current = nil
if current_raw then
  local ok, decoded = pcall(cjson.decode, current_raw)
  if ok and decoded.contractVersion == 'live-points-v2' then
    if decoded.season ~= candidate.season or decoded.eventId ~= candidate.eventId or decoded.entryId ~= candidate.entryId then
      current_scope_mismatch = true
    elseif type(decoded.generation) == 'number' and decoded.generation > 0 then
      current_generation = decoded.generation
      current_scope_valid = true
      current_state = decoded.state
    end
  end
  if ok and decoded.item and decoded.contractVersion == 'live-points-v2' and decoded.item.type == 'string' and redis.call('EXISTS', decoded.item.key) == 1 and redis.call('STRLEN', decoded.item.key) == decoded.item.bytes and redis.call('GET', decoded.item.key .. ':meta') == tostring(decoded.item.count) .. '|' .. tostring(decoded.item.bytes) .. '|' .. decoded.item.sha256 then current = decoded end
end
if candidate.contractVersion ~= 'live-points-v2' or not candidate.item then return {'invalid_candidate'} end
if current_scope_mismatch then return {'scope_mismatch'} end
if current_generation and current_generation >= candidate.generation then return {'stale', current_raw} end
if current_state == 'FINAL' then return {'stale', current_raw} end
local item = candidate.item
if redis.call('EXISTS', item.key) ~= 1 then return {'missing_stage', item.key} end
local type_result = redis.call('TYPE', item.key)
local actual_type = type(type_result) == 'table' and type_result['ok'] or type_result
if actual_type ~= 'string' or redis.call('STRLEN', item.key) ~= item.bytes or redis.call('GET', item.key .. ':meta') ~= tostring(item.count) .. '|' .. tostring(item.bytes) .. '|' .. item.sha256 then return {'invalid_stage', item.key} end
if current then
  if current.season ~= candidate.season or current.eventId ~= candidate.eventId or current.entryId ~= candidate.entryId then return {'scope_mismatch'} end
  if current.generation >= candidate.generation then return {'stale', current_raw} end
  redis.call('SET', KEYS[2], current_raw, 'PX', ARGV[2])
  if current.item.key and redis.call('EXISTS', current.item.key) == 1 then
    redis.call('PEXPIRE', current.item.key, ARGV[2])
    redis.call('PEXPIRE', current.item.key .. ':meta', ARGV[2])
  end
end
redis.call('PERSIST', item.key)
redis.call('PERSIST', item.key .. ':meta')
redis.call('SET', KEYS[1], ARGV[1])
local sequence = tonumber(redis.call('GET', KEYS[4]) or '0')
if sequence < candidate.generation then redis.call('SET', KEYS[4], tostring(candidate.generation)) end
return {'published', current_raw or ''}
`;

/**
 * Recovery is deliberately a compare-and-swap operation.  The caller must
 * first validate the previous immutable payload; this script then guarantees
 * that a concurrent producer cannot move a different current publication
 * while the operator is repairing the scope.
 */
const PROMOTE_PREVIOUS_LIVE_SCRIPT = `
local active_raw = redis.call('GET', KEYS[1]) or ''
local previous_raw = redis.call('GET', KEYS[2]) or ''
if active_raw ~= ARGV[1] or previous_raw ~= ARGV[2] then return {'changed'} end
if active_raw ~= '' then
  local active_state_ok, active_state = pcall(cjson.decode, active_raw)
  if active_state_ok and active_state.contractVersion == 'live-points-v2' and active_state.state == 'FINALIZED' then
    return {'changed'}
  end
end
local ok, previous = pcall(cjson.decode, previous_raw)
if not ok or previous.contractVersion ~= 'live-points-v2' or not previous.items or type(previous.generation) ~= 'number' or previous.generation <= 0 then return {'invalid_previous'} end
for _, name in ipairs({'eventLive', 'fixtures'}) do
  local item = previous.items[name]
  if not item or item.type ~= 'string' or redis.call('EXISTS', item.key) ~= 1 or redis.call('STRLEN', item.key) ~= item.bytes or redis.call('GET', item.key .. ':meta') ~= tostring(item.count) .. '|' .. tostring(item.bytes) .. '|' .. item.sha256 then return {'invalid_previous'} end
end
local active_is_valid = false
if active_raw ~= '' then
  local active_ok, active = pcall(cjson.decode, active_raw)
  if active_ok and active.contractVersion == 'live-points-v2' and active.items and type(active.generation) == 'number' and active.generation > 0 then
    active_is_valid = true
    for _, name in ipairs({'eventLive', 'fixtures'}) do
      local item = active.items[name]
      if not item or item.type ~= 'string' or redis.call('EXISTS', item.key) ~= 1 or redis.call('STRLEN', item.key) ~= item.bytes or redis.call('GET', item.key .. ':meta') ~= tostring(item.count) .. '|' .. tostring(item.bytes) .. '|' .. item.sha256 then active_is_valid = false end
    end
  end
end
if active_raw ~= '' then
  if active_is_valid then
    redis.call('SET', KEYS[2], active_raw, 'PX', ARGV[3])
    local active_ok, active = pcall(cjson.decode, active_raw)
    for _, name in ipairs({'eventLive', 'fixtures'}) do
      local item = active.items[name]
      if item and item.key and redis.call('EXISTS', item.key) == 1 then
        redis.call('PEXPIRE', item.key, ARGV[3])
        redis.call('PEXPIRE', item.key .. ':meta', ARGV[3])
      end
    end
  end
else
  redis.call('DEL', KEYS[2])
end
for _, name in ipairs({'eventLive', 'fixtures'}) do
  local item = previous.items[name]
  if previous.state == 'FINALIZED' then
    redis.call('PEXPIRE', item.key, ARGV[4])
    redis.call('PEXPIRE', item.key .. ':meta', ARGV[4])
  else
    redis.call('PERSIST', item.key)
    redis.call('PERSIST', item.key .. ':meta')
  end
end
redis.call('SET', KEYS[1], previous_raw)
if previous.state == 'FINALIZED' then redis.call('PEXPIRE', KEYS[1], ARGV[4]) else redis.call('PERSIST', KEYS[1]) end
local sequence = tonumber(redis.call('GET', KEYS[3]) or '0')
if sequence < previous.generation then redis.call('SET', KEYS[3], tostring(previous.generation)) end
return {'promoted', previous_raw}
`;

const TOUCH_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) then return {'changed'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 then return {'changed'} end
value.sourceCheckedAt = ARGV[3]
value.expectedNextCheckAt = ARGV[4] == '' and cjson.null or ARGV[4]
local encoded = cjson.encode(value)
if ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'PX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
end
return {'touched', cjson.encode(value)}
`;

const CHECKPOINT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) then return {'changed'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 then return {'changed'} end
value.checkpointedAt = ARGV[3]
local encoded = cjson.encode(value)
if ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'PX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
end
return {'checkpointed', cjson.encode(value)}
`;

const CHECKPOINT_ENTRY_SCRIPT = `
for index = 1, 2 do
  local raw = redis.call('GET', KEYS[index])
  if raw then
    local ok, value = pcall(cjson.decode, raw)
    if ok and value.publicationId == ARGV[1] and value.generation == tonumber(ARGV[2]) then
      local ttl = redis.call('PTTL', KEYS[index])
      if ttl == -2 then return {'changed'} end
      value.checkpointedAt = ARGV[3]
      local encoded = cjson.encode(value)
      if ttl > 0 then
        redis.call('SET', KEYS[index], encoded, 'PX', ttl)
      else
        redis.call('SET', KEYS[index], encoded)
      end
      return {'checkpointed', cjson.encode(value)}
    end
  end
end
return {'changed'}
`;

const CLEAR_CHECKPOINT_DESIRED_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) then return 0 end
return redis.call('DEL', KEYS[1])
`;

const SET_CHECKPOINT_DESIRED_SCRIPT = `
local existing_raw = redis.call('GET', KEYS[1])
local payload = ARGV[3]
if existing_raw then
  local ok, existing = pcall(cjson.decode, existing_raw)
  if ok and type(existing.generation) == 'number' then
    local candidate_generation = tonumber(ARGV[2])
    if existing.generation > candidate_generation then
      return {'kept', existing_raw}
    end
    if existing.generation == candidate_generation and existing.publicationId ~= ARGV[1] then
      return {'kept', existing_raw}
    end
    -- Keep the age of the first outstanding obligation while moving its
    -- desired pointer forward. Continuous score revisions must coalesce into
    -- one checkpoint window instead of resetting the ten-minute clock every
    -- thirty seconds. This script is shared by global and per-entry scopes.
    if existing.generation <= candidate_generation and type(existing.requestedAt) == 'string' and string.len(existing.requestedAt) == 24 then
      local candidateOk, candidate = pcall(cjson.decode, payload)
      if candidateOk and type(candidate) == 'table' then
        candidate.requestedAt = existing.requestedAt
        payload = cjson.encode(candidate)
      end
    end
  end
end
redis.call('SET', KEYS[1], payload, 'EX', ARGV[4])
return {'set', payload}
`;

async function allocateGeneration(
  redis: Redis,
  sequenceKey: string,
): Promise<{ generation: number; now: string }> {
  const result = (await redis.eval(ALLOCATE_GENERATION_SCRIPT, 1, sequenceKey)) as [
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
    throw new CacheError('Redis did not allocate a valid V2 generation', 'LIVE_V2_SEQUENCE_FAILED');
  }
  const now = new Date(seconds * 1_000 + Math.floor(micros / 1_000)).toISOString();
  return { generation, now };
}

async function stage(
  redis: Redis,
  items: readonly { manifest: PublicationItem; payload: string }[],
  overwrite = false,
): Promise<void> {
  const pipeline = redis.pipeline();
  for (const item of items) {
    if (overwrite) {
      pipeline.set(item.manifest.key, item.payload, 'PX', STAGING_TTL_MS);
      pipeline.set(
        itemMetadataKey(item.manifest.key),
        `${item.manifest.count}|${item.manifest.bytes}|${item.manifest.sha256}`,
        'PX',
        STAGING_TTL_MS,
      );
    } else {
      pipeline.set(item.manifest.key, item.payload, 'PX', STAGING_TTL_MS, 'NX');
      pipeline.set(
        itemMetadataKey(item.manifest.key),
        `${item.manifest.count}|${item.manifest.bytes}|${item.manifest.sha256}`,
        'PX',
        STAGING_TTL_MS,
        'NX',
      );
    }
  }
  const result = await pipeline.exec();
  if (!result || result.some(([error]) => error))
    throw new CacheError('V2 item staging failed', 'LIVE_V2_STAGE_FAILED');
  const values = await redis.mget(...items.map((item) => item.manifest.key));
  const metadata = await redis.mget(...items.map((item) => itemMetadataKey(item.manifest.key)));
  items.forEach((item, index) => {
    const payload = values[index];
    const expectedMetadata = `${item.manifest.count}|${item.manifest.bytes}|${item.manifest.sha256}`;
    if (
      payload === null ||
      metadata[index] !== expectedMetadata ||
      Buffer.byteLength(payload, 'utf8') !== item.manifest.bytes ||
      sha256(payload) !== item.manifest.sha256
    ) {
      throw new CacheError(
        `V2 item ${item.manifest.name} failed checksum validation`,
        'LIVE_V2_CHECKSUM_FAILED',
      );
    }
    try {
      if (
        publicationItemCount(item.manifest.name, JSON.parse(payload) as unknown) !==
        item.manifest.count
      )
        throw new Error('count');
    } catch {
      throw new CacheError(
        `V2 item ${item.manifest.name} is not valid JSON`,
        'LIVE_V2_PAYLOAD_INVALID',
      );
    }
  });
}

function promotionResult(result: unknown): [string, string?] {
  if (!Array.isArray(result) || typeof result[0] !== 'string')
    throw new CacheError('Invalid V2 promotion result', 'LIVE_V2_PROMOTE_FAILED');
  return result as [string, string?];
}

function sourceDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new CacheError('Invalid V2 source timestamp', 'LIVE_V2_TIME_INVALID');
  return date.toISOString();
}

export function buildLivePublicationRevisions(
  previous: LivePublicationV2 | null,
  state: LivePublicationState,
  eventLives: readonly EventLive[],
  fixtures: readonly Fixture[],
  now: string,
  contentTime = now,
): LivePublicationV2['revisions'] {
  const lifecycleRevision = contentHash({ state });
  const fixtureRevision = contentHash(
    fixtures.map((fixture) => ({
      id: fixture.id,
      code: fixture.code,
      event: fixture.event,
      kickoffTime: fixture.kickoffTime,
      teamH: fixture.teamH,
      teamA: fixture.teamA,
      teamHDifficulty: fixture.teamHDifficulty,
      teamADifficulty: fixture.teamADifficulty,
    })),
  );
  // Score-core is deliberately limited to fields used by the projection's
  // score/autosub decisions.  Display and explain changes must not wake every
  // score consumer or advance its revision.
  const scoreRevision = contentHash({
    eventLives: eventLives.map((row) => ({
      eventId: row.eventId,
      elementId: row.elementId,
      minutes: row.minutes,
      starts: row.starts,
      totalPoints: row.totalPoints,
    })),
    fixtureState: fixtures.map((fixture) => ({
      id: fixture.id,
      event: fixture.event,
      finished: fixture.finished,
      finishedProvisional: fixture.finishedProvisional,
      minutes: fixture.minutes,
      started: fixture.started,
      teamHScore: fixture.teamHScore,
      teamAScore: fixture.teamAScore,
    })),
  });
  const displayRevision = contentHash(
    eventLives.map((row) => ({
      elementId: row.elementId,
      minutes: row.minutes,
      goalsScored: row.goalsScored,
      assists: row.assists,
      cleanSheets: row.cleanSheets,
      goalsConceded: row.goalsConceded,
      ownGoals: row.ownGoals,
      penaltiesSaved: row.penaltiesSaved,
      penaltiesMissed: row.penaltiesMissed,
      yellowCards: row.yellowCards,
      redCards: row.redCards,
      saves: row.saves,
      bonus: row.bonus,
      bps: row.bps,
      defensiveContribution: row.defensiveContribution,
      starts: row.starts,
      totalPoints: row.totalPoints,
    })),
  );
  const explainRevision = contentHash(
    eventLives.map((row) => ({
      elementId: row.elementId,
      fixtureBreakdown: row.fixtureBreakdown ?? [],
    })),
  );
  const rulesRevision = contentHash({ algorithm: 'live-points-v2-rules-1' });
  return {
    lifecycle: contentUpdatedAt(previous?.revisions.lifecycle, lifecycleRevision, contentTime),
    fixtureIdentity: contentUpdatedAt(
      previous?.revisions.fixtureIdentity,
      fixtureRevision,
      contentTime,
    ),
    scoreCore: contentUpdatedAt(previous?.revisions.scoreCore, scoreRevision, contentTime),
    displayStats: contentUpdatedAt(previous?.revisions.displayStats, displayRevision, contentTime),
    explain: contentUpdatedAt(previous?.revisions.explain, explainRevision, contentTime),
    rules: contentUpdatedAt(previous?.revisions.rules, rulesRevision, contentTime),
  };
}

export async function publishLivePublicationV2(input: {
  readonly season: string;
  readonly eventId: number;
  readonly state: LivePublicationState;
  readonly sourceCheckedAt: Date | string;
  /** Cutover seed may preserve the legacy publication's semantic content time. */
  readonly contentUpdatedAt?: Date | string;
  readonly expectedNextCheckAt?: Date | string | null;
  readonly eventLives: readonly EventLive[];
  readonly fixtures: readonly Fixture[];
  readonly previous?: LivePublicationV2 | null;
  readonly redis?: Redis;
}): Promise<{
  readonly publication: LivePublicationV2;
  readonly previous: LivePublicationV2 | null;
  readonly published: boolean;
}> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertSeasonEvent(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  const allocation = await allocateGeneration(redis, liveV2Key(scope, 'sequence'));
  const sourceCheckedAt = sourceDate(input.sourceCheckedAt);
  const contentUpdatedAt =
    input.contentUpdatedAt == null ? allocation.now : sourceDate(input.contentUpdatedAt);
  const expectedNextCheckAt =
    input.expectedNextCheckAt == null ? null : sourceDate(input.expectedNextCheckAt);
  const liveItem = buildItem(scope, allocation.generation, 'eventLive', input.eventLives);
  const fixtureItem = buildItem(scope, allocation.generation, 'fixtures', input.fixtures);
  const manifest: LivePublicationV2 = {
    contractVersion: LIVE_POINTS_CONTRACT_VERSION,
    publicationId: randomUUID(),
    generation: allocation.generation,
    season: input.season,
    eventId: input.eventId,
    state: input.state,
    sourceCheckedAt,
    publishedAt: allocation.now,
    checkpointedAt: null,
    expectedNextCheckAt,
    revisions: buildLivePublicationRevisions(
      input.previous ?? null,
      input.state,
      input.eventLives,
      input.fixtures,
      allocation.now,
      contentUpdatedAt,
    ),
    items: { eventLive: liveItem.manifest, fixtures: fixtureItem.manifest },
  };
  await stage(redis, [liveItem, fixtureItem]);
  const [status, detail] = promotionResult(
    await redis.eval(
      PROMOTE_LIVE_SCRIPT,
      3,
      liveV2Key(scope, 'active'),
      liveV2Key(scope, 'previous'),
      liveV2Key(scope, 'sequence'),
      JSON.stringify(manifest),
      String(LIVE_PUBLICATION_PREVIOUS_TTL_MS),
      String(input.state === 'FINALIZED' ? LIVE_PUBLICATION_FINAL_TTL_MS : 0),
    ),
  );
  if (status === 'stale') {
    const stale = parseLiveManifest(detail ?? null, scope);
    if (!stale)
      throw new CacheError('V2 stale response has invalid current', 'LIVE_V2_PROMOTE_FAILED');
    return { publication: stale, previous: stale, published: false };
  }
  if (status !== 'published')
    throw new CacheError(`V2 promotion failed: ${status}`, 'LIVE_V2_PROMOTE_FAILED');
  return {
    publication: manifest,
    previous: parseLiveManifest(detail ?? null, scope),
    published: true,
  };
}

/**
 * Rebuild the V2 current pointer from an already validated PostgreSQL
 * checkpoint.  The publication identity and generation are preserved so an
 * operator repair does not manufacture a new business revision.  The Lua
 * promotion still applies the normal generation fence and advances the
 * sequence key, so a subsequent producer cannot allocate a lower generation.
 */
export async function restoreLivePublicationV2Checkpoint(input: {
  readonly checkpoint: LivePublicationRead;
  readonly redis?: Redis;
}): Promise<{
  readonly publication: LivePublicationV2;
  readonly previous: LivePublicationV2 | null;
  readonly published: boolean;
}> {
  const publication = input.checkpoint.publication;
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  assertSeasonEvent(scope);
  if (
    publication.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
    publication.generation <= 0 ||
    publication.publicationId.length === 0
  ) {
    throw new CacheError('Invalid V2 checkpoint identity', 'LIVE_V2_CHECKPOINT_INVALID');
  }
  const eventLiveItem = buildItem(
    scope,
    publication.generation,
    'eventLive',
    input.checkpoint.eventLives,
  );
  const fixtureItem = buildItem(
    scope,
    publication.generation,
    'fixtures',
    input.checkpoint.fixtures,
  );
  const sameManifest = (left: PublicationItem, right: PublicationItem): boolean =>
    left.name === right.name &&
    left.key === right.key &&
    left.type === right.type &&
    left.count === right.count &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256;
  if (
    !sameManifest(publication.items.eventLive, eventLiveItem.manifest) ||
    !sameManifest(publication.items.fixtures, fixtureItem.manifest)
  ) {
    throw new CacheError(
      'V2 checkpoint payload does not match its manifest',
      'LIVE_V2_CHECKPOINT_INVALID',
    );
  }
  const redis = input.redis ?? (await redisSingleton.getClient());
  // This is the protected exact-checkpoint repair path.  The payload has
  // already been validated against PostgreSQL's durable proof, so it may
  // replace an item key that was corrupted at the same generation.  Ordinary
  // publication continues to use NX staging and never overwrites a staged key.
  await stage(redis, [eventLiveItem, fixtureItem], true);
  const [status, detail] = promotionResult(
    await redis.eval(
      PROMOTE_LIVE_SCRIPT,
      3,
      liveV2Key(scope, 'active'),
      liveV2Key(scope, 'previous'),
      liveV2Key(scope, 'sequence'),
      JSON.stringify(publication),
      String(LIVE_PUBLICATION_PREVIOUS_TTL_MS),
      String(publication.state === 'FINALIZED' ? LIVE_PUBLICATION_FINAL_TTL_MS : 0),
    ),
  );
  if (status === 'stale') {
    const stale = parseLiveManifest(detail ?? null, scope);
    if (!stale)
      throw new CacheError(
        'V2 restore stale response has invalid current',
        'LIVE_V2_CHECKPOINT_RESTORE_FAILED',
      );
    return { publication: stale, previous: stale, published: false };
  }
  if (status !== 'published') {
    throw new CacheError(
      `V2 checkpoint restore failed: ${status}`,
      'LIVE_V2_CHECKPOINT_RESTORE_FAILED',
    );
  }
  return {
    publication,
    previous: parseLiveManifest(detail ?? null, scope),
    published: true,
  };
}

export async function promotePreviousLivePublicationV2(
  scope: LiveScope,
  redisClient?: Redis,
): Promise<{
  readonly status: 'promoted' | 'changed' | 'unavailable';
  readonly publication: LivePublicationV2 | null;
}> {
  assertSeasonEvent(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  const previous = await readLiveCandidate(redis, scope, 'previous');
  if (!previous) return { status: 'unavailable', publication: null };
  const activeRaw = (await redis.get(liveV2Key(scope, 'active'))) ?? '';
  const previousRaw = (await redis.get(liveV2Key(scope, 'previous'))) ?? '';
  const result = promotionResult(
    await redis.eval(
      PROMOTE_PREVIOUS_LIVE_SCRIPT,
      3,
      liveV2Key(scope, 'active'),
      liveV2Key(scope, 'previous'),
      liveV2Key(scope, 'sequence'),
      activeRaw,
      previousRaw,
      String(LIVE_PUBLICATION_PREVIOUS_TTL_MS),
      String(previous.publication.state === 'FINALIZED' ? LIVE_PUBLICATION_FINAL_TTL_MS : 0),
    ),
  );
  if (result[0] === 'changed') return { status: 'changed', publication: null };
  if (result[0] !== 'promoted') {
    throw new CacheError(`V2 previous promotion failed: ${result[0]}`, 'LIVE_V2_REPAIR_FAILED');
  }
  const promoted = parseLiveManifest(result[1] ?? null, scope);
  if (!promoted)
    throw new CacheError(
      'V2 previous promotion returned invalid manifest',
      'LIVE_V2_REPAIR_FAILED',
    );
  return { status: 'promoted', publication: promoted };
}

async function readLiveCandidate(
  redis: Redis,
  scope: LiveScope,
  pointer: 'active' | 'previous',
): Promise<LivePublicationRead | null> {
  const publication = parseLiveManifest(await redis.get(liveV2Key(scope, pointer)), scope);
  if (!publication) return null;
  const values = await redis.mget(
    publication.items.eventLive.key,
    publication.items.fixtures.key,
    itemMetadataKey(publication.items.eventLive.key),
    itemMetadataKey(publication.items.fixtures.key),
  );
  if (values.some((value) => value === null)) return null;
  const eventLivePayload = values[0] as string;
  const fixturePayload = values[1] as string;
  if (
    Buffer.byteLength(eventLivePayload, 'utf8') !== publication.items.eventLive.bytes ||
    sha256(eventLivePayload) !== publication.items.eventLive.sha256 ||
    Buffer.byteLength(fixturePayload, 'utf8') !== publication.items.fixtures.bytes ||
    sha256(fixturePayload) !== publication.items.fixtures.sha256 ||
    values[2] !==
      `${publication.items.eventLive.count}|${publication.items.eventLive.bytes}|${publication.items.eventLive.sha256}` ||
    values[3] !==
      `${publication.items.fixtures.count}|${publication.items.fixtures.bytes}|${publication.items.fixtures.sha256}`
  )
    return null;
  try {
    const eventLives = JSON.parse(eventLivePayload) as unknown;
    const fixtures = JSON.parse(fixturePayload) as unknown;
    if (
      !Array.isArray(eventLives) ||
      !Array.isArray(fixtures) ||
      itemCount(eventLives) !== publication.items.eventLive.count ||
      itemCount(fixtures) !== publication.items.fixtures.count ||
      !eventLives.every(
        (row) =>
          row !== null &&
          typeof row === 'object' &&
          Number.isSafeInteger((row as { eventId?: unknown }).eventId) &&
          (row as { eventId: number }).eventId === scope.eventId &&
          Number.isSafeInteger((row as { elementId?: unknown }).elementId) &&
          (row as { elementId: number }).elementId > 0 &&
          Number.isSafeInteger((row as { totalPoints?: unknown }).totalPoints),
      ) ||
      new Set(eventLives.map((row) => (row as { elementId: number }).elementId)).size !==
        eventLives.length ||
      !fixtures.every(
        (fixture) =>
          fixture !== null &&
          typeof fixture === 'object' &&
          Number.isSafeInteger((fixture as { id?: unknown }).id) &&
          (fixture as { id: number }).id > 0 &&
          Number.isSafeInteger((fixture as { teamH?: unknown }).teamH) &&
          Number.isSafeInteger((fixture as { teamA?: unknown }).teamA) &&
          ((fixture as { event?: unknown }).event === null ||
            (fixture as { event?: unknown }).event === scope.eventId),
      ) ||
      new Set(fixtures.map((fixture) => (fixture as { id: number }).id)).size !== fixtures.length
    )
      return null;
    return {
      publication,
      eventLives: eventLives as EventLive[],
      fixtures: fixtures as Fixture[],
      servedFrom: pointer === 'active' ? 'REDIS_CURRENT' : 'REDIS_PREVIOUS',
    };
  } catch {
    return null;
  }
}

export async function readLivePublicationV2(
  scope: LiveScope,
  redisClient?: Redis,
): Promise<LivePublicationRead | null> {
  assertSeasonEvent(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  return (
    (await readLiveCandidate(redis, scope, 'active')) ??
    (await readLiveCandidate(redis, scope, 'previous'))
  );
}

/** Read one pointer for diagnostics and protected repair tooling. */
export async function readLivePublicationV2Pointer(
  scope: LiveScope,
  pointer: 'active' | 'previous',
  redisClient?: Redis,
): Promise<LivePublicationRead | null> {
  assertSeasonEvent(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  return readLiveCandidate(redis, scope, pointer);
}

/**
 * Read one exact publication generation.  This is used by background capture
 * code as an ordering fence; it never falls back to a different event or a
 * newer generation just because the requested one is missing.
 */
export async function readLivePublicationV2ByReference(
  scope: LiveScope,
  reference: { readonly publicationId: string; readonly generation: number },
  redisClient?: Redis,
): Promise<LivePublicationRead | null> {
  assertSeasonEvent(scope);
  if (
    !reference.publicationId ||
    !Number.isSafeInteger(reference.generation) ||
    reference.generation <= 0
  ) {
    return null;
  }
  const redis = redisClient ?? (await redisSingleton.getClient());
  for (const pointer of ['active', 'previous'] as const) {
    const candidate = await readLiveCandidate(redis, scope, pointer);
    if (
      candidate &&
      candidate.publication.publicationId === reference.publicationId &&
      candidate.publication.generation === reference.generation
    ) {
      return candidate;
    }
  }
  return null;
}

export async function touchLivePublicationV2(
  publication: LivePublicationV2,
  sourceCheckedAt: Date | string,
  expectedNextCheckAt: Date | string | null,
  redisClient?: Redis,
): Promise<LivePublicationV2 | null> {
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  const redis = redisClient ?? (await redisSingleton.getClient());
  const result = promotionResult(
    await redis.eval(
      TOUCH_SCRIPT,
      1,
      liveV2Key(scope, 'active'),
      publication.publicationId,
      String(publication.generation),
      sourceDate(sourceCheckedAt),
      expectedNextCheckAt == null ? '' : sourceDate(expectedNextCheckAt),
    ),
  );
  return result[0] === 'touched'
    ? parseLiveManifest(result[1] ?? null, scope)
    : readLivePublicationV2(scope, redis).then((value) => value?.publication ?? null);
}

export async function markLivePublicationCheckpointedV2(
  publication: LivePublicationV2,
  checkpointedAt: Date | string,
  redisClient?: Redis,
): Promise<LivePublicationV2 | null> {
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  const redis = redisClient ?? (await redisSingleton.getClient());
  const result = promotionResult(
    await redis.eval(
      CHECKPOINT_SCRIPT,
      1,
      liveV2Key(scope, 'active'),
      publication.publicationId,
      String(publication.generation),
      sourceDate(checkpointedAt),
    ),
  );
  return result[0] === 'checkpointed' ? parseLiveManifest(result[1] ?? null, scope) : null;
}

export interface LiveCheckpointDesiredV2 {
  readonly contractVersion: typeof LIVE_POINTS_CONTRACT_VERSION;
  readonly season: string;
  readonly eventId: number;
  readonly publicationId: string;
  readonly generation: number;
  readonly requestedAt: string;
}

export async function setLiveCheckpointDesiredV2(
  publication: LivePublicationV2,
  requestedAt: Date | string = new Date(),
  redisClient?: Redis,
): Promise<LiveCheckpointDesiredV2> {
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  const desired: LiveCheckpointDesiredV2 = {
    contractVersion: LIVE_POINTS_CONTRACT_VERSION,
    season: publication.season,
    eventId: publication.eventId,
    publicationId: publication.publicationId,
    generation: publication.generation,
    requestedAt: sourceDate(requestedAt),
  };
  const redis = redisClient ?? (await redisSingleton.getClient());
  const result = promotionResult(
    await redis.eval(
      SET_CHECKPOINT_DESIRED_SCRIPT,
      1,
      liveV2CheckpointDesiredKey(scope),
      desired.publicationId,
      String(desired.generation),
      JSON.stringify(desired),
      String(7 * 24 * 60 * 60),
    ),
  );
  const persisted = JSON.parse(result[1] ?? JSON.stringify(desired)) as unknown;
  if (
    !isRecord(persisted) ||
    persisted.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
    persisted.season !== scope.season ||
    persisted.eventId !== scope.eventId ||
    typeof persisted.publicationId !== 'string' ||
    typeof persisted.generation !== 'number' ||
    !Number.isSafeInteger(persisted.generation) ||
    persisted.generation <= 0 ||
    !validIso(persisted.requestedAt)
  ) {
    throw new CacheError(
      'Redis stored an invalid V2 checkpoint obligation',
      'LIVE_V2_CHECKPOINT_DESIRED_INVALID',
    );
  }
  return persisted as unknown as LiveCheckpointDesiredV2;
}

export async function readLiveCheckpointDesiredV2(
  scope: LiveScope,
  redisClient?: Redis,
): Promise<LiveCheckpointDesiredV2 | null> {
  assertSeasonEvent(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  const raw = await redis.get(liveV2CheckpointDesiredKey(scope));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      value.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
      value.season !== scope.season ||
      value.eventId !== scope.eventId ||
      typeof value.publicationId !== 'string' ||
      typeof value.generation !== 'number' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation <= 0 ||
      !validIso(value.requestedAt)
    )
      return null;
    return value as unknown as LiveCheckpointDesiredV2;
  } catch {
    return null;
  }
}

export async function clearLiveCheckpointDesiredV2(
  desired: LiveCheckpointDesiredV2,
  redisClient?: Redis,
): Promise<boolean> {
  const scope = { season: desired.season, eventId: desired.eventId } as const;
  const redis = redisClient ?? (await redisSingleton.getClient());
  return (
    Number(
      await redis.eval(
        CLEAR_CHECKPOINT_DESIRED_SCRIPT,
        1,
        liveV2CheckpointDesiredKey(scope),
        desired.publicationId,
        String(desired.generation),
      ),
    ) === 1
  );
}

function buildEntryInputFromPicks(
  season: string,
  eventId: number,
  entryId: number,
  picks: RawFPLEntryEventPicksResponse,
  sourceCheckedAt: string,
): EntryLiveInputV2 {
  const normalized = picks.picks
    .map((pick) => ({
      element: pick.element,
      position: pick.position,
      multiplier: pick.multiplier,
      isCaptain: pick.is_captain,
      isViceCaptain: pick.is_vice_captain,
    }))
    .sort((left, right) => left.position - right.position) as unknown as Exactly15Picks;
  const picksRevision = contentHash({
    picks: normalized,
    chip: picks.active_chip,
    transferCost: picks.entry_history.event_transfers_cost,
  });
  return {
    contractVersion: LIVE_POINTS_CONTRACT_VERSION,
    season,
    eventId,
    entryId,
    picksBase: {
      revision: picksRevision,
      contentUpdatedAt: sourceCheckedAt,
      picks: normalized,
      chip: picks.active_chip ?? null,
      transferCost: picks.entry_history.event_transfers_cost,
    },
    previousTotals: null,
    officialAdjustment: null,
    finalResult: null,
  };
}

export async function publishEntryLiveInputV2(input: {
  readonly season: string;
  readonly eventId: number;
  readonly entryId: number;
  readonly input: EntryLiveInputV2;
  readonly sourceCheckedAt: Date | string;
  readonly redis?: Redis;
}): Promise<{
  readonly publication: EntryLivePublicationV2;
  readonly previous: EntryLivePublicationV2 | null;
  readonly published: boolean;
}> {
  const scope = { season: input.season, eventId: input.eventId, entryId: input.entryId } as const;
  assertEntryScope(scope);
  if (!validateEntryLiveInputV2(input.input, scope))
    throw new CacheError('Invalid V2 entry input', 'LIVE_V2_ENTRY_INPUT_INVALID');
  const redis = input.redis ?? (await redisSingleton.getClient());
  const allocation = await allocateGeneration(redis, entryLiveV2Key(scope, 'sequence'));
  const sourceCheckedAt = sourceDate(input.sourceCheckedAt);
  const item = buildEntryItem(scope, allocation.generation, input.input);
  const publication: EntryLivePublicationV2 = {
    contractVersion: LIVE_POINTS_CONTRACT_VERSION,
    publicationId: randomUUID(),
    generation: allocation.generation,
    season: input.season,
    eventId: input.eventId,
    entryId: input.entryId,
    state: input.input.finalResult === null ? 'PROVISIONAL' : 'FINAL',
    sourceCheckedAt,
    publishedAt: allocation.now,
    checkpointedAt: null,
    expectedNextCheckAt: null,
    item: item.manifest,
  };
  await stage(redis, [item]);
  const [status, detail] = promotionResult(
    await redis.eval(
      PROMOTE_ENTRY_SCRIPT,
      4,
      entryLiveV2Key(scope, 'active'),
      entryLiveV2Key(scope, 'previous'),
      entryLiveV2ItemKey(scope, allocation.generation),
      entryLiveV2Key(scope, 'sequence'),
      JSON.stringify(publication),
      String(LIVE_PUBLICATION_PREVIOUS_TTL_MS),
    ),
  );
  if (status === 'stale') {
    const stale = parseEntryManifest(detail ?? null, scope);
    if (!stale)
      throw new CacheError(
        'V2 stale entry response has invalid current',
        'LIVE_V2_ENTRY_PROMOTE_FAILED',
      );
    return { publication: stale, previous: stale, published: false };
  }
  if (status !== 'published')
    throw new CacheError(`V2 entry promotion failed: ${status}`, 'LIVE_V2_ENTRY_PROMOTE_FAILED');
  return { publication, previous: parseEntryManifest(detail ?? null, scope), published: true };
}

/**
 * FINAL_RESULT is a milestone publication, never a periodic live heartbeat.
 * It is built only from a complete entry result that was observed after the
 * event's data_checked fence.  The ordinary picks publisher is not allowed to
 * downgrade this input back to a provisional projection.
 */
export async function publishEntryLiveFinalResultV2(input: {
  readonly season: string;
  readonly eventId: number;
  readonly entryId: number;
  readonly sourceCheckedAt: Date | string;
  readonly dataCheckedAt: Date | string;
  readonly finalResult: {
    readonly score: FinalScore;
    readonly picks: Exactly15Picks;
    readonly automaticSubs: readonly OfficialSubstitution[];
  };
  readonly redis?: Redis;
}): Promise<{
  readonly publication: EntryLivePublicationV2;
  readonly previous: EntryLivePublicationV2 | null;
  readonly published: boolean;
}> {
  const scope = { season: input.season, eventId: input.eventId, entryId: input.entryId } as const;
  assertEntryScope(scope);
  const sourceCheckedAt = sourceDate(input.sourceCheckedAt);
  const dataCheckedAt = sourceDate(input.dataCheckedAt);
  if (new Date(sourceCheckedAt).getTime() < new Date(dataCheckedAt).getTime()) {
    throw new CacheError(
      'Final V2 entry result predates the event data_checked fence',
      'LIVE_V2_FINAL_EVIDENCE_STALE',
    );
  }
  const current = await readEntryLiveInputV2(scope, input.redis);
  if (!current) {
    throw new CacheError(
      'Final V2 entry result has no complete base input',
      'LIVE_V2_FINAL_INPUT_MISSING',
    );
  }
  const multipliers = input.finalResult.picks.map((pick) => ({
    element: pick.element,
    multiplier: pick.multiplier,
  }));
  const officialAdjustmentRevision = contentHash({
    dataCheckedAt,
    multipliers,
    automaticSubs: input.finalResult.automaticSubs,
  });
  const finalResultRevision = contentHash({
    dataCheckedAt,
    score: input.finalResult.score,
    picks: input.finalResult.picks,
    automaticSubs: input.finalResult.automaticSubs,
  });
  if (current.input.finalResult?.revision === finalResultRevision) {
    return { publication: current.publication, previous: null, published: false };
  }
  const nextInput: EntryLiveInputV2 = {
    ...current.input,
    officialAdjustment: {
      revision: officialAdjustmentRevision,
      multipliers,
      automaticSubs: input.finalResult.automaticSubs,
    },
    finalResult: {
      revision: finalResultRevision,
      score: input.finalResult.score,
      picks: input.finalResult.picks,
      automaticSubs: input.finalResult.automaticSubs,
    },
  };
  if (!validateEntryLiveInputV2(nextInput, scope)) {
    throw new CacheError('Invalid final V2 entry input', 'LIVE_V2_FINAL_INPUT_INVALID');
  }
  return publishEntryLiveInputV2({
    season: input.season,
    eventId: input.eventId,
    entryId: input.entryId,
    input: nextInput,
    sourceCheckedAt,
    redis: input.redis,
  });
}

async function readEntryCandidate(
  redis: Redis,
  scope: EntryScope,
  pointer: 'active' | 'previous',
): Promise<EntryLivePublicationRead | null> {
  const publication = parseEntryManifest(await redis.get(entryLiveV2Key(scope, pointer)), scope);
  if (!publication) return null;
  const [payload, metadata] = await redis.mget(
    publication.item.key,
    itemMetadataKey(publication.item.key),
  );
  if (
    payload === null ||
    metadata !== `${publication.item.count}|${publication.item.bytes}|${publication.item.sha256}` ||
    Buffer.byteLength(payload, 'utf8') !== publication.item.bytes ||
    sha256(payload) !== publication.item.sha256
  )
    return null;
  try {
    const input = JSON.parse(payload) as unknown;
    if (
      !validateEntryLiveInputV2(input, scope) ||
      itemCount(input.picksBase.picks) !== publication.item.count
    )
      return null;
    return {
      publication,
      input,
      servedFrom: pointer === 'active' ? 'REDIS_CURRENT' : 'REDIS_PREVIOUS',
    };
  } catch {
    return null;
  }
}

export async function readEntryLiveInputV2(
  scope: EntryScope,
  redisClient?: Redis,
): Promise<EntryLivePublicationRead | null> {
  assertEntryScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  return (
    (await readEntryCandidate(redis, scope, 'active')) ??
    (await readEntryCandidate(redis, scope, 'previous'))
  );
}

export async function markEntryPublicationCheckpointedV2(
  publication: EntryLivePublicationV2,
  checkpointedAt: Date | string,
  redisClient?: Redis,
): Promise<EntryLivePublicationV2 | null> {
  const scope = {
    season: publication.season,
    eventId: publication.eventId,
    entryId: publication.entryId,
  } as const;
  const redis = redisClient ?? (await redisSingleton.getClient());
  const result = promotionResult(
    await redis.eval(
      CHECKPOINT_ENTRY_SCRIPT,
      2,
      entryLiveV2Key(scope, 'active'),
      entryLiveV2Key(scope, 'previous'),
      publication.publicationId,
      String(publication.generation),
      sourceDate(checkpointedAt),
    ),
  );
  return result[0] === 'checkpointed' ? parseEntryManifest(result[1] ?? null, scope) : null;
}

/**
 * A Redis publication can succeed immediately before PostgreSQL becomes
 * unavailable.  Keep one durable-in-Redis obligation for that exact entry so
 * the next canary/reconciler pass retries the database checkpoint without
 * publishing a second candidate or creating a periodic sweep.
 */
export async function setEntryCheckpointDesiredV2(
  publication: EntryLivePublicationV2,
  requestedAt: Date | string = new Date(),
  redisClient?: Redis,
): Promise<EntryLiveCheckpointDesiredV2> {
  const scope = {
    season: publication.season,
    eventId: publication.eventId,
    entryId: publication.entryId,
  } as const;
  const desired: EntryLiveCheckpointDesiredV2 = {
    contractVersion: LIVE_POINTS_CONTRACT_VERSION,
    season: publication.season,
    eventId: publication.eventId,
    entryId: publication.entryId,
    publicationId: publication.publicationId,
    generation: publication.generation,
    sourceCheckedAt: publication.sourceCheckedAt,
    requestedAt: sourceDate(requestedAt),
  };
  const redis = redisClient ?? (await redisSingleton.getClient());
  const result = promotionResult(
    await redis.eval(
      SET_CHECKPOINT_DESIRED_SCRIPT,
      1,
      entryLiveV2CheckpointDesiredKey(scope),
      desired.publicationId,
      String(desired.generation),
      JSON.stringify(desired),
      String(7 * 24 * 60 * 60),
    ),
  );
  const persisted = JSON.parse(result[1] ?? JSON.stringify(desired)) as unknown;
  if (
    !isRecord(persisted) ||
    persisted.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
    persisted.season !== scope.season ||
    persisted.eventId !== scope.eventId ||
    persisted.entryId !== scope.entryId ||
    typeof persisted.publicationId !== 'string' ||
    typeof persisted.generation !== 'number' ||
    !Number.isSafeInteger(persisted.generation) ||
    persisted.generation <= 0 ||
    !validIso(persisted.sourceCheckedAt) ||
    !validIso(persisted.requestedAt)
  ) {
    throw new CacheError(
      'Redis stored an invalid V2 entry checkpoint obligation',
      'LIVE_V2_ENTRY_CHECKPOINT_DESIRED_INVALID',
    );
  }
  return persisted as unknown as EntryLiveCheckpointDesiredV2;
}

export async function readEntryCheckpointDesiredV2(
  scope: EntryScope,
  redisClient?: Redis,
): Promise<EntryLiveCheckpointDesiredV2 | null> {
  assertEntryScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  const raw = await redis.get(entryLiveV2CheckpointDesiredKey(scope));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      value.contractVersion !== LIVE_POINTS_CONTRACT_VERSION ||
      value.season !== scope.season ||
      value.eventId !== scope.eventId ||
      value.entryId !== scope.entryId ||
      typeof value.publicationId !== 'string' ||
      typeof value.generation !== 'number' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation <= 0 ||
      !validIso(value.sourceCheckedAt) ||
      !validIso(value.requestedAt)
    )
      return null;
    return value as unknown as EntryLiveCheckpointDesiredV2;
  } catch {
    return null;
  }
}

export async function clearEntryCheckpointDesiredV2(
  desired: EntryLiveCheckpointDesiredV2,
  redisClient?: Redis,
): Promise<boolean> {
  const scope = {
    season: desired.season,
    eventId: desired.eventId,
    entryId: desired.entryId,
  } as const;
  const redis = redisClient ?? (await redisSingleton.getClient());
  return (
    Number(
      await redis.eval(
        CLEAR_CHECKPOINT_DESIRED_SCRIPT,
        1,
        entryLiveV2CheckpointDesiredKey(scope),
        desired.publicationId,
        String(desired.generation),
      ),
    ) === 1
  );
}

export function entryLiveInputFromFplPicks(
  season: FplSeasonRef,
  eventId: number,
  entryId: number,
  picks: RawFPLEntryEventPicksResponse,
  sourceCheckedAt: Date | string,
): EntryLiveInputV2 {
  return buildEntryInputFromPicks(
    season.seasonCode,
    eventId,
    entryId,
    picks,
    sourceDate(sourceCheckedAt),
  );
}
