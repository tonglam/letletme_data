import { randomUUID } from 'node:crypto';

import type Redis from 'ioredis';

import { canonicalJson, contentHash } from '../utils/content-hash';
import { CacheError } from '../utils/errors';
import { redisSingleton } from './singleton';
import type {
  MatchDeskFixture,
  MatchDetailPlayer,
  MatchFixtureDetail,
  MatchLifecycleState,
} from '../services/live-match-v3';
import { isCanonicalPlayerPrice } from '../domain/players';

export const LIVE_MATCHES_CONTRACT_VERSION = 'live-matches-v3' as const;
export const LIVE_MATCHES_REDIS_PREFIX = 'llm:data:v3:fpl:live-match' as const;
export const LIVE_MATCH_PREVIOUS_TTL_MS = 24 * 60 * 60_000;
export const LIVE_MATCH_FINAL_TTL_MS = 48 * 60 * 60_000;
export const LIVE_MATCH_STAGING_TTL_MS = 15 * 60_000;
export const LIVE_MATCH_MAX_FIXTURES = 32;
export const LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE = 64;
export const LIVE_MATCH_MAX_STATS_PER_PLAYER = 32;
export const LIVE_MATCH_MAX_PUBLICATION_BYTES = 128 * 1024;
export const LIVE_MATCH_MAX_DESK_BYTES = 128 * 1024;
export const LIVE_MATCH_MAX_DETAIL_ITEM_BYTES = 256 * 1024;
export const LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES = 2 * 1024 * 1024;

export type StreamRevision = Readonly<{
  revision: string;
  contentUpdatedAt: string;
}>;

export type MatchDeskPublication = Readonly<{
  contractVersion: typeof LIVE_MATCHES_CONTRACT_VERSION;
  publicationId: string;
  generation: number;
  season: string;
  eventId: number;
  state: MatchLifecycleState;
  sourceCheckedAt: string;
  publishedAt: string;
  checkpointedAt: string | null;
  expectedNextCheckAt: string | null;
  staleAt: string | null;
  revisions: {
    lifecycle: StreamRevision;
    fixtureIdentity: StreamRevision;
    scoreState: StreamRevision;
  };
  desk: MatchPublicationItem;
}>;

export type MatchDetailItem = Readonly<{
  fixtureId: number;
  key: string;
  type: 'string';
  count: number;
  bytes: number;
  sha256: string;
}>;

export type MatchDetailPublication = Readonly<{
  contractVersion: typeof LIVE_MATCHES_CONTRACT_VERSION;
  publicationId: string;
  generation: number;
  season: string;
  eventId: number;
  /** Internal finalization fence; never exposed in the GraphQL contract. */
  finalized: boolean;
  observedDeskGeneration: number;
  fixtureIdentityRevision: string;
  sourceCheckedAt: string;
  publishedAt: string;
  checkpointedAt: string | null;
  expectedNextCheckAt: string | null;
  staleAt: string | null;
  detail: StreamRevision;
  fixtures: readonly MatchDetailItem[];
}>;

export type MatchPublicationItem = Readonly<{
  name: 'desk';
  key: string;
  type: 'string';
  count: number;
  bytes: number;
  sha256: string;
}>;

export type MatchDeskRead = Readonly<{
  publication: MatchDeskPublication;
  fixtures: readonly MatchDeskFixture[];
  servedFrom: 'REDIS_CURRENT' | 'REDIS_PREVIOUS' | 'POSTGRES_CHECKPOINT';
}>;

/**
 * An active desk read together with the exact Redis pointer bytes observed at
 * the start of an upstream observation. The bytes are an ordering fence, not
 * business data; promotion must compare them in Lua so an older provider
 * response cannot overwrite a desk published while that response was in
 * flight.
 */
export type MatchDeskActiveFence = Readonly<{
  observed: string;
  read: MatchDeskRead | null;
}>;

export type MatchDetailRead = Readonly<{
  publication: MatchDetailPublication;
  fixtures: readonly MatchFixtureDetail[];
  servedFrom: 'REDIS_CURRENT' | 'REDIS_PREVIOUS' | 'POSTGRES_CHECKPOINT';
}>;

/**
 * An active detail pointer and the fully validated value observed with it.
 * The raw pointer bytes are the ordering fence; promotion and heartbeat touch
 * must compare them in Lua so an older provider response cannot overwrite a
 * detail publication that won while that response was in flight.
 */
export type MatchDetailActiveFence = Readonly<{
  observed: string;
  read: MatchDetailRead | null;
}>;

export type MatchCheckpointDesired = Readonly<{
  contractVersion: typeof LIVE_MATCHES_CONTRACT_VERSION;
  kind: 'desk' | 'detail';
  season: string;
  eventId: number;
  publicationId: string;
  generation: number;
  requestedAt: string;
  final: boolean;
  /** Boundary publications bypass the normal ten-minute DB coalescing window. */
  force: boolean;
}>;

type MatchScope = Readonly<{ season: string; eventId: number }>;

function assertScope(scope: MatchScope): void {
  if (!/^\d{4}$/.test(scope.season)) {
    throw new CacheError('Invalid Live Matches V3 season', 'LIVE_MATCH_SEASON_INVALID');
  }
  if (!Number.isSafeInteger(scope.eventId) || scope.eventId <= 0) {
    throw new CacheError('Invalid Live Matches V3 event', 'LIVE_MATCH_EVENT_INVALID');
  }
}

export function liveMatchActiveEventKey(season: string): string {
  if (!/^\d{4}$/.test(season)) {
    throw new CacheError('Invalid Live Matches V3 season', 'LIVE_MATCH_SEASON_INVALID');
  }
  return `llm:data:v3:fpl:live-match:${season}:active-event`;
}

export function liveMatchDeskKey(
  scope: MatchScope,
  suffix: 'active' | 'previous' | 'sequence',
): string {
  assertScope(scope);
  return `llm:data:v3:fpl:live-match:desk:${scope.season}:${scope.eventId}:${suffix}`;
}

export function liveMatchDeskItemKey(scope: MatchScope, generation: number): string {
  assertScope(scope);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new CacheError('Invalid Live Matches V3 generation', 'LIVE_MATCH_GENERATION_INVALID');
  }
  return `llm:data:v3:fpl:live-match:desk:${scope.season}:${scope.eventId}:${generation}:desk`;
}

export function liveMatchDetailKey(
  scope: MatchScope,
  suffix: 'active' | 'previous' | 'sequence',
): string {
  assertScope(scope);
  return `llm:data:v3:fpl:live-match:detail:${scope.season}:${scope.eventId}:${suffix}`;
}

export function liveMatchDetailManifestKey(scope: MatchScope, generation: number): string {
  assertScope(scope);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new CacheError('Invalid Live Matches V3 generation', 'LIVE_MATCH_GENERATION_INVALID');
  }
  return `llm:data:v3:fpl:live-match:detail:${scope.season}:${scope.eventId}:${generation}:manifest`;
}

export function liveMatchDetailItemKey(
  scope: MatchScope,
  generation: number,
  fixtureId: number,
  sha256: string,
): string {
  assertScope(scope);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new CacheError('Invalid Live Matches V3 generation', 'LIVE_MATCH_GENERATION_INVALID');
  }
  if (!Number.isSafeInteger(fixtureId) || fixtureId <= 0) {
    throw new CacheError('Invalid Live Matches V3 fixture', 'LIVE_MATCH_FIXTURE_INVALID');
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new CacheError('Invalid Live Matches V3 item hash', 'LIVE_MATCH_HASH_INVALID');
  }
  return `llm:data:v3:fpl:live-match:detail:${scope.season}:${scope.eventId}:${generation}:${fixtureId}:${sha256}`;
}

export function liveMatchCheckpointKey(scope: MatchScope, kind: 'desk' | 'detail'): string {
  assertScope(scope);
  return `llm:data:v3:fpl:live-match:checkpoint:${scope.season}:${scope.eventId}:${kind}`;
}

export function liveMatchCheckpointLastKey(scope: MatchScope, kind: 'desk' | 'detail'): string {
  assertScope(scope);
  return `llm:data:v3:fpl:live-match:checkpoint:${scope.season}:${scope.eventId}:${kind}:last`;
}

function metadataKey(key: string): string {
  return `${key}:meta`;
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function sourceDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CacheError('Invalid Live Matches V3 timestamp', 'LIVE_MATCH_TIME_INVALID');
  }
  return date.toISOString();
}

function itemCount(value: unknown): number {
  return Array.isArray(value) ? value.length : value === null || value === undefined ? 0 : 1;
}

function itemMetadata(item: Readonly<{ count: number; bytes: number; sha256: string }>): string {
  return `${item.count}|${item.bytes}|${item.sha256}`;
}

function manifestItem(name: 'desk', key: string, value: unknown): MatchPublicationItem {
  const payload = canonicalJson(value);
  return {
    name,
    key,
    type: 'string',
    count: itemCount(value),
    bytes: Buffer.byteLength(payload, 'utf8'),
    sha256: contentHash(value),
  };
}

function detailItem(
  scope: MatchScope,
  generation: number,
  fixtureId: number,
  players: readonly MatchDetailPlayer[],
): MatchDetailItem {
  const payload = canonicalJson(players);
  const sha256 = contentHash(players);
  return {
    fixtureId,
    key: liveMatchDetailItemKey(scope, generation, fixtureId, sha256),
    type: 'string',
    count: players.length,
    bytes: Buffer.byteLength(payload, 'utf8'),
    sha256,
  };
}

function limitExceeded(message: string): never {
  throw new CacheError(message, 'LIVE_MATCH_PAYLOAD_LIMIT_EXCEEDED');
}

function assertDeskLimits(fixtures: readonly MatchDeskFixture[]): void {
  if (fixtures.length > LIVE_MATCH_MAX_FIXTURES) {
    limitExceeded(`Live Match desk fixture count exceeds ${LIVE_MATCH_MAX_FIXTURES}`);
  }
  if (Buffer.byteLength(canonicalJson(fixtures), 'utf8') > LIVE_MATCH_MAX_DESK_BYTES) {
    limitExceeded(`Live Match desk payload exceeds ${LIVE_MATCH_MAX_DESK_BYTES} bytes`);
  }
}

function assertDetailLimits(fixtures: readonly MatchFixtureDetail[]): void {
  if (fixtures.length > LIVE_MATCH_MAX_FIXTURES) {
    limitExceeded(`Live Match detail fixture count exceeds ${LIVE_MATCH_MAX_FIXTURES}`);
  }
  for (const fixture of fixtures) {
    if (fixture.players.length > LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE) {
      limitExceeded(
        `Live Match detail player count exceeds ${LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE} for fixture ${fixture.fixtureId}`,
      );
    }
    for (const player of fixture.players) {
      if (player.stats.length > LIVE_MATCH_MAX_STATS_PER_PLAYER) {
        limitExceeded(
          `Live Match detail stat count exceeds ${LIVE_MATCH_MAX_STATS_PER_PLAYER} for player ${player.id}`,
        );
      }
    }
    const bytes = Buffer.byteLength(canonicalJson(fixture.players), 'utf8');
    if (bytes > LIVE_MATCH_MAX_DETAIL_ITEM_BYTES) {
      limitExceeded(
        `Live Match detail payload exceeds ${LIVE_MATCH_MAX_DETAIL_ITEM_BYTES} bytes for fixture ${fixture.fixtureId}`,
      );
    }
  }
  // The PostgreSQL checkpoint stores the self-contained fixture envelope, not
  // just the concatenated player arrays. Gate the exact durable payload here
  // so every Redis publication is guaranteed to be checkpointable, including
  // final publications that may never be superseded.
  if (Buffer.byteLength(canonicalJson(fixtures), 'utf8') > LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES) {
    limitExceeded(
      `Live Match detail payload exceeds ${LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES} total bytes`,
    );
  }
}

function assertPublicationBytes(publication: unknown): void {
  if (Buffer.byteLength(canonicalJson(publication), 'utf8') > LIVE_MATCH_MAX_PUBLICATION_BYTES) {
    limitExceeded(`Live Match manifest exceeds ${LIVE_MATCH_MAX_PUBLICATION_BYTES} bytes`);
  }
}

function revision(
  previous: StreamRevision | undefined,
  value: unknown,
  contentUpdatedAt: string,
): StreamRevision {
  const next = contentHash(value);
  return previous?.revision === next ? previous : { revision: next, contentUpdatedAt };
}

const ALLOCATE_GENERATION_LUA = `
local floor = tonumber(ARGV[1]) or 0
local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
if current < floor then redis.call('SET', KEYS[1], tostring(floor)) end
local generation = redis.call('INCR', KEYS[1])
local now = redis.call('TIME')
return {tostring(generation), tostring(now[1]), tostring(now[2])}
`;

// Checkpoint restore is the one path allowed to repair a corrupted immutable
// item. Keep the payload and its metadata replacement in one Redis script so
// a failed repair cannot leave a half-repaired item visible to promotion.
const RESTORE_STAGE_LUA = `
if (#KEYS % 2) ~= 0 or #ARGV ~= (#KEYS / 2) * 3 then return redis.error_reply('invalid restore stage') end
for index = 1, #KEYS, 2 do
  local argument = ((index - 1) / 2) * 3 + 1
  local payloadTtl = redis.call('PTTL', KEYS[index])
  local metadataTtl = redis.call('PTTL', KEYS[index + 1])
  redis.call('SET', KEYS[index], ARGV[argument])
  redis.call('SET', KEYS[index + 1], ARGV[argument + 1])
  -- A restore may be a no-op because the active publication already equals
  -- the durable checkpoint. Do not turn a persistent/current or final item
  -- into a short-lived staging value just because promotion returns stale.
  -- Missing keys still get a bounded lease so promotion has time to consume
  -- the repaired item; an existing TTL is retained exactly.
  if payloadTtl > 0 then
    redis.call('PEXPIRE', KEYS[index], payloadTtl)
  elseif payloadTtl == -2 then
    redis.call('PEXPIRE', KEYS[index], ARGV[argument + 2])
  end
  if metadataTtl > 0 then
    redis.call('PEXPIRE', KEYS[index + 1], metadataTtl)
  elseif metadataTtl == -2 then
    redis.call('PEXPIRE', KEYS[index + 1], ARGV[argument + 2])
  end
end
return 'staged'
`;

const SET_ACTIVE_EVENT_LUA = `
local candidate = tonumber(ARGV[1])
if not candidate then return redis.error_reply('invalid candidate event') end
local current = tonumber(redis.call('GET', KEYS[1]) or '')
if current and current > candidate then return tostring(current) end
redis.call('SET', KEYS[1], tostring(candidate))
return tostring(candidate)
`;

const PROMOTE_DESK_LUA = `
if string.len(ARGV[1]) > ${LIVE_MATCH_MAX_PUBLICATION_BYTES} then return {'invalid_candidate'} end
local candidate = cjson.decode(ARGV[1])
local observed = ARGV[2] or ''
local currentRaw = redis.call('GET', KEYS[1]) or ''
if currentRaw ~= observed then return {'changed'} end
if candidate.contractVersion ~= 'live-matches-v3' or type(candidate.desk) ~= 'table' then return {'invalid_candidate'} end
if type(candidate.generation) ~= 'number' or type(candidate.season) ~= 'string' or type(candidate.eventId) ~= 'number' then return {'invalid_candidate'} end
local expectedDeskKey = 'llm:data:v3:fpl:live-match:desk:' .. candidate.season .. ':' .. tostring(candidate.eventId) .. ':' .. tostring(candidate.generation) .. ':desk'
if candidate.desk.key ~= expectedDeskKey or candidate.desk.type ~= 'string' or type(candidate.desk.sha256) ~= 'string' or not string.match(candidate.desk.sha256, '^[0-9a-f]+$') or string.len(candidate.desk.sha256) ~= 64 or type(candidate.desk.count) ~= 'number' or candidate.desk.count < 0 or candidate.desk.count > ${LIVE_MATCH_MAX_FIXTURES} or type(candidate.desk.bytes) ~= 'number' or candidate.desk.bytes < 0 or candidate.desk.bytes > ${LIVE_MATCH_MAX_DESK_BYTES} then return {'invalid_candidate'} end
local current = nil
if currentRaw ~= '' then
  local ok, decoded = pcall(cjson.decode, currentRaw)
  if ok and type(decoded) == 'table' and decoded.contractVersion == 'live-matches-v3' and type(decoded.generation) == 'number' then
    current = decoded
  end
end
local validatedId = ARGV[5] or ''
local validatedGeneration = tonumber(ARGV[6] or '')
local repairMode = ARGV[7] or ''
if ARGV[8] == '1' then
  local observedDetail = ARGV[9] or ''
  local currentDetailRaw = redis.call('GET', KEYS[4]) or ''
  if currentDetailRaw ~= observedDetail then return {'detail_changed'} end
end
if validatedId ~= '' and (not current or current.publicationId ~= validatedId or current.generation ~= validatedGeneration) then return {'changed'} end
if current and current.state == 'FINALIZED' and validatedId ~= '' then return {'stale', currentRaw} end
if current and current.generation >= candidate.generation and (repairMode == '' or (repairMode == 'restore' and validatedId ~= '')) then return {'stale', currentRaw} end
local item = candidate.desk
if redis.call('EXISTS', item.key) ~= 1 then return {'missing_item'} end
local itemType = redis.call('TYPE', item.key)
if type(itemType) == 'table' then itemType = itemType['ok'] end
if itemType ~= 'string' or redis.call('STRLEN', item.key) ~= item.bytes or redis.call('GET', item.key .. ':meta') ~= tostring(item.count) .. '|' .. tostring(item.bytes) .. '|' .. item.sha256 then return {'invalid_item'} end
if currentRaw ~= '' and current and validatedId ~= '' then
  redis.call('SET', KEYS[2], currentRaw, 'PX', ARGV[3])
  if current.desk and current.desk.key then
    redis.call('PEXPIRE', current.desk.key, ARGV[3])
    redis.call('PEXPIRE', current.desk.key .. ':meta', ARGV[3])
  end
end
if candidate.state == 'FINALIZED' then
  redis.call('PEXPIRE', item.key, ARGV[4])
  redis.call('PEXPIRE', item.key .. ':meta', ARGV[4])
else
  redis.call('PERSIST', item.key)
  redis.call('PERSIST', item.key .. ':meta')
end
redis.call('SET', KEYS[1], ARGV[1])
if candidate.state == 'FINALIZED' then redis.call('PEXPIRE', KEYS[1], ARGV[4]) else redis.call('PERSIST', KEYS[1]) end
local sequence = tonumber(redis.call('GET', KEYS[3]) or '0')
if sequence < candidate.generation then redis.call('SET', KEYS[3], tostring(candidate.generation)) end
return {'published', currentRaw}
`;

const PROMOTE_DETAIL_LUA = `
if string.len(ARGV[1]) > ${LIVE_MATCH_MAX_PUBLICATION_BYTES} then return {'invalid_candidate'} end
local candidate = cjson.decode(ARGV[1])
local observed = ARGV[2] or ''
local currentRaw = redis.call('GET', KEYS[1]) or ''
if currentRaw ~= observed then return {'changed'} end
if candidate.contractVersion ~= 'live-matches-v3' or type(candidate.fixtures) ~= 'table' then return {'invalid_candidate'} end
if type(candidate.generation) ~= 'number' or type(candidate.season) ~= 'string' or type(candidate.eventId) ~= 'number' or type(candidate.finalized) ~= 'boolean' or type(candidate.observedDeskGeneration) ~= 'number' or candidate.observedDeskGeneration <= 0 or type(candidate.fixtureIdentityRevision) ~= 'string' or string.len(candidate.fixtureIdentityRevision) ~= 64 then return {'invalid_candidate'} end
local deskRaw = redis.call('GET', KEYS[4]) or ''
local deskOk, desk = pcall(cjson.decode, deskRaw)
local deskRevision = nil
if deskOk and type(desk) == 'table' and type(desk.revisions) == 'table' and type(desk.revisions.fixtureIdentity) == 'table' then deskRevision = desk.revisions.fixtureIdentity.revision end
local repairMode = ARGV[8] or ''
local exactDeskGeneration = deskOk and type(desk) == 'table' and type(desk.generation) == 'number' and desk.generation == candidate.observedDeskGeneration
local compatibleLaggingDesk = (repairMode == 'rollback' or repairMode == 'restore') and candidate.finalized == false and deskOk and type(desk) == 'table' and desk.state ~= 'FINALIZED' and type(desk.generation) == 'number' and desk.generation >= candidate.observedDeskGeneration
local deskCompatible = deskOk and type(desk) == 'table' and desk.contractVersion == 'live-matches-v3' and desk.season == candidate.season and desk.eventId == candidate.eventId and type(desk.generation) == 'number' and type(desk.state) == 'string' and type(deskRevision) == 'string' and deskRevision == candidate.fixtureIdentityRevision and (exactDeskGeneration or compatibleLaggingDesk) and ((desk.state == 'FINALIZED') == (candidate.finalized == true))
if not deskCompatible then
  -- A provisional retry must not turn an already-final detail into a hard
  -- failure merely because its desk has crossed the finalization fence. Keep
  -- the complete final detail as LKG; all other desk races fail closed.
  if deskOk and type(desk) == 'table' and desk.contractVersion == 'live-matches-v3' and desk.season == candidate.season and desk.eventId == candidate.eventId and desk.state == 'FINALIZED' and candidate.finalized == false and currentRaw ~= '' then
    local currentOk, currentValue = pcall(cjson.decode, currentRaw)
    if currentOk and type(currentValue) == 'table' and currentValue.contractVersion == 'live-matches-v3' and currentValue.finalized == true then return {'stale', currentRaw} end
  end
  return {'desk_changed'}
end
local current = nil
if currentRaw ~= '' then
  local ok, decoded = pcall(cjson.decode, currentRaw)
  if ok and type(decoded) == 'table' and decoded.contractVersion == 'live-matches-v3' and type(decoded.generation) == 'number' then current = decoded end
end
local validatedId = ARGV[6] or ''
local validatedGeneration = tonumber(ARGV[7] or '')
if validatedId ~= '' and (not current or current.publicationId ~= validatedId or current.generation ~= validatedGeneration) then return {'changed'} end
if current and current.finalized == true and validatedId ~= '' then return {'stale', currentRaw} end
if current and current.generation >= candidate.generation and (repairMode == '' or (repairMode == 'restore' and validatedId ~= '')) then return {'stale', currentRaw} end
if type(candidate.generation) ~= 'number' or type(candidate.season) ~= 'string' or type(candidate.eventId) ~= 'number' then return {'invalid_candidate'} end
if #candidate.fixtures > ${LIVE_MATCH_MAX_FIXTURES} then return {'invalid_candidate'} end
local totalBytes = 0
for _, item in ipairs(candidate.fixtures) do
  if type(item) ~= 'table' or item.type ~= 'string' or type(item.fixtureId) ~= 'number' or type(item.key) ~= 'string' or type(item.sha256) ~= 'string' or not string.match(item.sha256, '^[0-9a-f]+$') or string.len(item.sha256) ~= 64 or type(item.count) ~= 'number' or item.count < 0 or item.count > ${LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE} or type(item.bytes) ~= 'number' or item.bytes < 0 or item.bytes > ${LIVE_MATCH_MAX_DETAIL_ITEM_BYTES} then return {'invalid_candidate'} end
  local prefix = 'llm:data:v3:fpl:live-match:detail:' .. candidate.season .. ':' .. tostring(candidate.eventId) .. ':'
  local suffix = ':' .. tostring(item.fixtureId) .. ':' .. item.sha256
  if string.sub(item.key, 1, string.len(prefix)) ~= prefix or string.sub(item.key, -string.len(suffix)) ~= suffix then return {'invalid_candidate'} end
  local itemGeneration = string.sub(item.key, string.len(prefix) + 1, string.len(item.key) - string.len(suffix))
  if not string.match(itemGeneration, '^[1-9][0-9]*$') then return {'invalid_candidate'} end
  totalBytes = totalBytes + item.bytes
  if totalBytes > ${LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES} then return {'invalid_candidate'} end
end
for _, item in ipairs(candidate.fixtures) do
  if redis.call('EXISTS', item.key) ~= 1 then return {'missing_item'} end
  local itemType = redis.call('TYPE', item.key)
  if type(itemType) == 'table' then itemType = itemType['ok'] end
  if itemType ~= 'string' or redis.call('STRLEN', item.key) ~= item.bytes or redis.call('GET', item.key .. ':meta') ~= tostring(item.count) .. '|' .. tostring(item.bytes) .. '|' .. item.sha256 then return {'invalid_item'} end
end
if currentRaw ~= '' and current and validatedId ~= '' then
  redis.call('SET', KEYS[2], currentRaw, 'PX', ARGV[3])
end
if currentRaw ~= '' and current and validatedId ~= '' then
  local oldManifestKey = 'llm:data:v3:fpl:live-match:detail:' .. current.season .. ':' .. tostring(current.eventId) .. ':' .. tostring(current.generation) .. ':manifest'
  redis.call('PEXPIRE', oldManifestKey, ARGV[3])
  for _, oldItem in ipairs(current.fixtures or {}) do
    if oldItem.key then
      redis.call('PEXPIRE', oldItem.key, ARGV[3])
      redis.call('PEXPIRE', oldItem.key .. ':meta', ARGV[3])
    end
  end
end
for _, item in ipairs(candidate.fixtures) do
  if ARGV[4] == '1' then
    redis.call('PEXPIRE', item.key, ARGV[5])
    redis.call('PEXPIRE', item.key .. ':meta', ARGV[5])
  else
    redis.call('PERSIST', item.key)
    redis.call('PERSIST', item.key .. ':meta')
  end
end
local manifestKey = 'llm:data:v3:fpl:live-match:detail:' .. candidate.season .. ':' .. tostring(candidate.eventId) .. ':' .. tostring(candidate.generation) .. ':manifest'
redis.call('SET', manifestKey, ARGV[1])
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[4] == '1' then
  redis.call('PEXPIRE', manifestKey, ARGV[5])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
else
  redis.call('PERSIST', manifestKey)
  redis.call('PERSIST', KEYS[1])
end
local sequence = tonumber(redis.call('GET', KEYS[3]) or '0')
if sequence < candidate.generation then redis.call('SET', KEYS[3], tostring(candidate.generation)) end
return {'published', currentRaw}
`;

const TOUCH_ONE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
if raw ~= (ARGV[6] or '') then return {'changed'} end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) then return {'changed'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 then return {'changed'} end
value.sourceCheckedAt = ARGV[3]
value.expectedNextCheckAt = ARGV[4] == '' and cjson.null or ARGV[4]
value.staleAt = ARGV[5] == '' and cjson.null or ARGV[5]
local encoded = cjson.encode(value)
if ttl > 0 then redis.call('SET', KEYS[1], encoded, 'PX', ttl) else redis.call('SET', KEYS[1], encoded) end
return {'touched', encoded}
`;

const TOUCH_DETAIL_LUA = `
local raw = redis.call('GET', KEYS[1])
local manifestRaw = redis.call('GET', KEYS[2])
if not raw or not manifestRaw then return {'missing'} end
if raw ~= (ARGV[6] or '') then return {'changed'} end
local ok, value = pcall(cjson.decode, raw)
local manifestOk, manifest = pcall(cjson.decode, manifestRaw)
if not ok or not manifestOk or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) or manifest.publicationId ~= value.publicationId or manifest.generation ~= value.generation then return {'changed'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 then return {'changed'} end
value.sourceCheckedAt = ARGV[3]
value.expectedNextCheckAt = ARGV[4] == '' and cjson.null or ARGV[4]
value.staleAt = ARGV[5] == '' and cjson.null or ARGV[5]
local encoded = cjson.encode(value)
if ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'PX', ttl)
  redis.call('SET', KEYS[2], encoded, 'PX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
  redis.call('SET', KEYS[2], encoded)
end
return {'touched', encoded}
`;

/** TTL-only final lease renewal. The active pointer remains the CAS fence. */
const RENEW_DESK_FINAL_LEASE_LUA = `
local raw = redis.call('GET', KEYS[1]) or ''
if raw ~= (ARGV[1] or '') then return {'changed'} end
local ok, value = pcall(cjson.decode, raw)
if not ok or type(value) ~= 'table' or value.contractVersion ~= 'live-matches-v3' or
   value.publicationId ~= ARGV[2] or value.generation ~= tonumber(ARGV[3]) or
   value.state ~= 'FINALIZED' or type(value.desk) ~= 'table' then return {'invalid'} end
local item = value.desk
if item.name ~= 'desk' or item.type ~= 'string' or type(item.key) ~= 'string' or
   type(item.count) ~= 'number' or item.count < 0 or item.count ~= math.floor(item.count) or
   type(item.bytes) ~= 'number' or item.bytes < 0 or item.bytes ~= math.floor(item.bytes) or
   type(item.sha256) ~= 'string' or string.len(item.sha256) ~= 64 or
   redis.call('EXISTS', item.key) ~= 1 then return {'invalid'} end
local itemType = redis.call('TYPE', item.key)
if type(itemType) == 'table' then itemType = itemType['ok'] end
if itemType ~= 'string' or redis.call('STRLEN', item.key) ~= item.bytes or
   redis.call('GET', item.key .. ':meta') ~= tostring(item.count) .. '|' .. tostring(item.bytes) .. '|' .. item.sha256 then return {'invalid'} end
if redis.call('PTTL', KEYS[1]) == -2 then return {'missing'} end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', item.key, ARGV[4])
redis.call('PEXPIRE', item.key .. ':meta', ARGV[4])
return {'renewed', tostring(redis.call('PTTL', KEYS[1]))}
`;

const RENEW_DETAIL_FINAL_LEASE_LUA = `
local raw = redis.call('GET', KEYS[1]) or ''
local manifestRaw = redis.call('GET', KEYS[2]) or ''
if raw ~= (ARGV[1] or '') then return {'changed'} end
local ok, value = pcall(cjson.decode, raw)
local manifestOk, manifest = pcall(cjson.decode, manifestRaw)
if not ok or not manifestOk or type(value) ~= 'table' or type(manifest) ~= 'table' or
   value.contractVersion ~= 'live-matches-v3' or value.publicationId ~= ARGV[2] or
   value.generation ~= tonumber(ARGV[3]) or value.finalized ~= true or
   manifest.publicationId ~= value.publicationId or manifest.generation ~= value.generation or
   manifest.finalized ~= true or type(value.fixtures) ~= 'table' then return {'invalid'} end
for _, item in ipairs(value.fixtures) do
  if type(item) ~= 'table' or item.type ~= 'string' or type(item.key) ~= 'string' or
     type(item.fixtureId) ~= 'number' or item.fixtureId <= 0 or
     type(item.count) ~= 'number' or item.count < 0 or item.count ~= math.floor(item.count) or
     type(item.bytes) ~= 'number' or item.bytes < 0 or item.bytes ~= math.floor(item.bytes) or
     type(item.sha256) ~= 'string' or string.len(item.sha256) ~= 64 or
     redis.call('EXISTS', item.key) ~= 1 then return {'invalid'} end
  local itemType = redis.call('TYPE', item.key)
  if type(itemType) == 'table' then itemType = itemType['ok'] end
  if itemType ~= 'string' or redis.call('STRLEN', item.key) ~= item.bytes or
     redis.call('GET', item.key .. ':meta') ~= tostring(item.count) .. '|' .. tostring(item.bytes) .. '|' .. item.sha256 then return {'invalid'} end
end
if redis.call('PTTL', KEYS[1]) == -2 or redis.call('PTTL', KEYS[2]) == -2 then return {'missing'} end
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
for _, item in ipairs(value.fixtures) do
  redis.call('PEXPIRE', item.key, ARGV[4])
  redis.call('PEXPIRE', item.key .. ':meta', ARGV[4])
end
return {'renewed', tostring(redis.call('PTTL', KEYS[1]))}
`;

const CHECKPOINT_ONE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing'} end
local ok, value = pcall(cjson.decode, raw)
if not ok or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) then return {'changed'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 then return {'changed'} end
value.checkpointedAt = ARGV[3]
local encoded = cjson.encode(value)
if ttl > 0 then redis.call('SET', KEYS[1], encoded, 'PX', ttl) else redis.call('SET', KEYS[1], encoded) end
local last = cjson.encode({
  contractVersion = 'live-matches-v3',
  kind = 'desk',
  season = value.season,
  eventId = value.eventId,
  publicationId = value.publicationId,
  generation = value.generation,
  checkpointedAt = ARGV[3]
})
redis.call('SET', KEYS[2], last, 'EX', ARGV[4])
return {'checkpointed', encoded}
`;

const CHECKPOINT_DETAIL_LUA = `
local raw = redis.call('GET', KEYS[1])
local manifestRaw = redis.call('GET', KEYS[2])
if not raw or not manifestRaw then return {'missing'} end
local ok, value = pcall(cjson.decode, raw)
local manifestOk, manifest = pcall(cjson.decode, manifestRaw)
if not ok or not manifestOk or value.publicationId ~= ARGV[1] or value.generation ~= tonumber(ARGV[2]) or manifest.publicationId ~= value.publicationId or manifest.generation ~= value.generation then return {'changed'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 then return {'changed'} end
value.checkpointedAt = ARGV[3]
local encoded = cjson.encode(value)
if ttl > 0 then
  redis.call('SET', KEYS[1], encoded, 'PX', ttl)
  redis.call('SET', KEYS[2], encoded, 'PX', ttl)
else
  redis.call('SET', KEYS[1], encoded)
  redis.call('SET', KEYS[2], encoded)
end
local last = cjson.encode({
  contractVersion = 'live-matches-v3',
  kind = 'detail',
  season = value.season,
  eventId = value.eventId,
  publicationId = value.publicationId,
  generation = value.generation,
  checkpointedAt = ARGV[3]
})
redis.call('SET', KEYS[3], last, 'EX', ARGV[4])
return {'checkpointed', encoded}
`;

const SET_DESIRED_LUA = `
local currentRaw = redis.call('GET', KEYS[1])
local candidate = cjson.decode(ARGV[1])
local replacingFinalized = false
if currentRaw then
  local ok, current = pcall(cjson.decode, currentRaw)
  if ok and type(current.generation) == 'number' then
    if current.final == true then
      -- A finalized desired marker is immutable during normal operation. The
      -- only exception is the destructive cutover seed, which must prove both
      -- the exact marker it observed and a finalized, forced candidate. This
      -- fenced CAS prevents a concurrent final marker from being overwritten.
      local allowReplacement = ARGV[3] == '1'
      local expectedGeneration = tonumber(ARGV[5])
      if allowReplacement and candidate.final == true and candidate.force == true and
         current.publicationId == ARGV[4] and current.generation == expectedGeneration and
         candidate.generation >= current.generation then
        replacingFinalized = true
      else
        return {'kept', currentRaw}
      end
    end
    if not replacingFinalized then
      if current.generation > candidate.generation then
        -- Never replace a newer publication with an older checkpoint target, but
        -- do carry a boundary's urgency onto that newer target.  Otherwise a
        -- lifecycle/identity boundary can be silently coalesced for ten minutes
        -- simply because a newer score publication won the desired-pointer race.
        if candidate.force == true and current.force ~= true then
          current.force = true
          local encoded = cjson.encode(current)
          redis.call('SET', KEYS[1], encoded, 'EX', ARGV[2])
          return {'set', encoded}
        end
        return {'kept', currentRaw}
      end
      if current.generation == candidate.generation and current.publicationId ~= candidate.publicationId then return {'kept', currentRaw} end
      if current.generation == candidate.generation and current.publicationId == candidate.publicationId then
        candidate.force = current.force == true or candidate.force == true
        if type(current.requestedAt) == 'string' then candidate.requestedAt = current.requestedAt end
        local encoded = cjson.encode(candidate)
        redis.call('SET', KEYS[1], encoded, 'EX', ARGV[2])
        return {'set', encoded}
      end
      if type(current.requestedAt) == 'string' then candidate.requestedAt = current.requestedAt end
    end
  end
end
local encoded = cjson.encode(candidate)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[2])
return {'set', encoded}
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
): Promise<{ generation: number; now: string }> {
  const result = (await redis.eval(ALLOCATE_GENERATION_LUA, 1, sequenceKey, String(floor))) as [
    string,
    string,
    string,
  ];
  const generation = Number(result[0]);
  const seconds = Number(result[1]);
  const micros = Number(result[2]);
  if (!Number.isSafeInteger(generation) || generation <= 0 || !Number.isFinite(seconds)) {
    throw new CacheError(
      'Live Matches V3 sequence allocation failed',
      'LIVE_MATCH_SEQUENCE_FAILED',
    );
  }
  return {
    generation,
    now: new Date(seconds * 1_000 + Math.floor(micros / 1_000)).toISOString(),
  };
}

async function stage(
  redis: Redis,
  values: readonly Readonly<{
    key: string;
    payload: string;
    item: Readonly<{ count: number; bytes: number; sha256: string }>;
  }>[],
  mode: 'create' | 'restore' = 'create',
): Promise<void> {
  if (values.length === 0) return;
  if (values.length > LIVE_MATCH_MAX_FIXTURES) {
    limitExceeded(`Live Match stage item count exceeds ${LIVE_MATCH_MAX_FIXTURES}`);
  }
  for (const value of values) {
    if (
      value.item.count > LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE ||
      value.item.bytes > LIVE_MATCH_MAX_DETAIL_ITEM_BYTES ||
      Buffer.byteLength(value.payload, 'utf8') !== value.item.bytes
    ) {
      limitExceeded('Live Match staged item exceeds its bounded manifest');
    }
  }
  if (mode === 'restore') {
    const keys = values.flatMap((value) => [value.key, metadataKey(value.key)]);
    const args = values.flatMap((value) => [
      value.payload,
      itemMetadata(value.item),
      String(LIVE_MATCH_STAGING_TTL_MS),
    ]);
    const result = await redis.eval(RESTORE_STAGE_LUA, keys.length, ...keys, ...args);
    if (result !== 'staged') {
      throw new CacheError(
        'Live Matches V3 item restore staging failed',
        'LIVE_MATCH_STAGE_FAILED',
      );
    }
  } else {
    const pipeline = redis.pipeline();
    for (const value of values) {
      pipeline.set(value.key, value.payload, 'PX', LIVE_MATCH_STAGING_TTL_MS, 'NX');
      pipeline.set(
        metadataKey(value.key),
        itemMetadata(value.item),
        'PX',
        LIVE_MATCH_STAGING_TTL_MS,
        'NX',
      );
    }
    const result = await pipeline.exec();
    if (!result || result.some(([error]) => error)) {
      throw new CacheError('Live Matches V3 item staging failed', 'LIVE_MATCH_STAGE_FAILED');
    }
  }
  const payloads = await redis.mget(...values.map((value) => value.key));
  const metadata = await redis.mget(...values.map((value) => metadataKey(value.key)));
  values.forEach((value, index) => {
    if (
      payloads[index] !== value.payload ||
      metadata[index] !== itemMetadata(value.item) ||
      Buffer.byteLength(payloads[index] ?? '', 'utf8') !== value.item.bytes ||
      contentHash(JSON.parse(payloads[index] ?? 'null')) !== value.item.sha256
    ) {
      throw new CacheError(
        'Live Matches V3 staged item checksum failed',
        'LIVE_MATCH_CHECKSUM_FAILED',
      );
    }
  });
}

function promotionResult(value: unknown): [string, string?] {
  if (!Array.isArray(value) || typeof value[0] !== 'string') {
    throw new CacheError('Invalid Live Matches V3 promotion result', 'LIVE_MATCH_PROMOTE_FAILED');
  }
  return value as [string, string?];
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function validRevision(value: unknown): value is StreamRevision {
  return (
    record(value) &&
    typeof value.revision === 'string' &&
    /^[0-9a-f]{64}$/.test(value.revision) &&
    validIso(value.contentUpdatedAt)
  );
}

function validState(value: unknown): value is MatchLifecycleState {
  return (
    value === 'PRE_DEADLINE' ||
    value === 'LIVE_ACTIVE' ||
    value === 'BETWEEN_FIXTURES' ||
    value === 'DAY_SETTLING' ||
    value === 'GW_REVIEW' ||
    value === 'FINALIZED'
  );
}

function validDeskFixture(value: unknown, eventId: number): value is MatchDeskFixture {
  if (!record(value)) return false;
  const fixtureId = safeInteger(value.fixtureId);
  const homeTeamId = safeInteger(value.homeTeamId);
  const awayTeamId = safeInteger(value.awayTeamId);
  const minutes = safeInteger(value.minutes);
  const homeScore = value.homeScore === null ? null : safeInteger(value.homeScore);
  const awayScore = value.awayScore === null ? null : safeInteger(value.awayScore);
  return (
    fixtureId !== null &&
    fixtureId > 0 &&
    value.eventId === eventId &&
    homeTeamId !== null &&
    homeTeamId > 0 &&
    awayTeamId !== null &&
    awayTeamId > 0 &&
    homeTeamId !== awayTeamId &&
    typeof value.homeTeamName === 'string' &&
    value.homeTeamName.trim().length > 0 &&
    typeof value.homeTeamShortName === 'string' &&
    value.homeTeamShortName.trim().length > 0 &&
    typeof value.awayTeamName === 'string' &&
    value.awayTeamName.trim().length > 0 &&
    typeof value.awayTeamShortName === 'string' &&
    value.awayTeamShortName.trim().length > 0 &&
    minutes !== null &&
    minutes >= 0 &&
    (value.homeScore === null || (homeScore !== null && homeScore >= 0)) &&
    (value.awayScore === null || (awayScore !== null && awayScore >= 0)) &&
    (value.kickoffTime === null || validIso(value.kickoffTime)) &&
    typeof value.started === 'boolean' &&
    typeof value.finished === 'boolean' &&
    typeof value.finishedProvisional === 'boolean'
  );
}

function validDeskPayload(value: unknown, eventId: number): value is readonly MatchDeskFixture[] {
  return (
    Array.isArray(value) &&
    value.length <= LIVE_MATCH_MAX_FIXTURES &&
    Buffer.byteLength(canonicalJson(value), 'utf8') <= LIVE_MATCH_MAX_DESK_BYTES &&
    new Set(value.map((fixture) => (record(fixture) ? fixture.fixtureId : null))).size ===
      value.length &&
    value.every((fixture) => validDeskFixture(fixture, eventId))
  );
}

export function isValidLiveMatchDeskPayloadV3(
  value: unknown,
  eventId: number,
): value is readonly MatchDeskFixture[] {
  return validDeskPayload(value, eventId);
}

function validDetailPlayer(value: unknown): value is MatchDetailPlayer {
  if (!record(value)) return false;
  const id = safeInteger(value.id);
  const position = safeInteger(value.position);
  const teamId = safeInteger(value.teamId);
  const price = safeInteger(value.price);
  const totalPoints = safeInteger(value.totalPoints);
  if (
    !(
      id !== null &&
      id > 0 &&
      typeof value.webName === 'string' &&
      value.webName.trim().length > 0 &&
      position !== null &&
      position >= 1 &&
      position <= 4 &&
      teamId !== null &&
      teamId > 0 &&
      price !== null &&
      isCanonicalPlayerPrice(price) &&
      totalPoints !== null &&
      Array.isArray(value.stats) &&
      value.stats.length <= LIVE_MATCH_MAX_STATS_PER_PLAYER &&
      new Set(
        value.stats.map((stat) =>
          record(stat) && typeof stat.identifier === 'string'
            ? stat.identifier.trim().toLowerCase()
            : null,
        ),
      ).size === value.stats.length &&
      value.stats.every(
        (stat) =>
          record(stat) &&
          typeof stat.identifier === 'string' &&
          stat.identifier.trim().length > 0 &&
          typeof stat.value === 'number' &&
          Number.isFinite(stat.value) &&
          typeof stat.awardedPoints === 'number' &&
          Number.isFinite(stat.awardedPoints),
      )
    )
  )
    return false;
  const awardedPoints = value.stats.reduce(
    (sum, stat) =>
      sum +
      (record(stat) && typeof stat.awardedPoints === 'number' && Number.isFinite(stat.awardedPoints)
        ? stat.awardedPoints
        : 0),
    0,
  );
  return awardedPoints === totalPoints;
}

function validDetailPayload(value: unknown): value is readonly MatchDetailPlayer[] {
  return (
    Array.isArray(value) &&
    value.length <= LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE &&
    Buffer.byteLength(canonicalJson(value), 'utf8') <= LIVE_MATCH_MAX_DETAIL_ITEM_BYTES &&
    new Set(value.map((player) => (record(player) ? player.id : null))).size === value.length &&
    value.every(validDetailPlayer)
  );
}

export function isValidLiveMatchDetailCheckpointPayloadV3(
  value: unknown,
): value is readonly MatchFixtureDetail[] {
  return (
    Array.isArray(value) &&
    value.length <= LIVE_MATCH_MAX_FIXTURES &&
    new Set(value.map((fixture) => (record(fixture) ? fixture.fixtureId : null))).size ===
      value.length &&
    value.every(
      (fixture) =>
        record(fixture) &&
        safeInteger(fixture.fixtureId) !== null &&
        (safeInteger(fixture.fixtureId) as number) > 0 &&
        validDetailPayload(fixture.players),
    ) &&
    Buffer.byteLength(canonicalJson(value), 'utf8') <= LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES
  );
}

function parseDeskPublication(raw: string | null, scope: MatchScope): MatchDeskPublication | null {
  if (raw !== null && Buffer.byteLength(raw, 'utf8') > LIVE_MATCH_MAX_PUBLICATION_BYTES)
    return null;
  const value = parseJson(raw);
  if (!record(value)) return null;
  const generation = safeInteger(value.generation);
  if (
    value.contractVersion !== LIVE_MATCHES_CONTRACT_VERSION ||
    typeof value.publicationId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(value.publicationId) ||
    generation === null ||
    generation <= 0 ||
    value.season !== scope.season ||
    value.eventId !== scope.eventId ||
    !validState(value.state) ||
    !validIso(value.sourceCheckedAt) ||
    !validIso(value.publishedAt) ||
    (value.checkpointedAt !== null && !validIso(value.checkpointedAt)) ||
    (value.expectedNextCheckAt !== null && !validIso(value.expectedNextCheckAt)) ||
    (value.staleAt !== null && !validIso(value.staleAt)) ||
    !record(value.revisions) ||
    !validRevision(value.revisions.lifecycle) ||
    !validRevision(value.revisions.fixtureIdentity) ||
    !validRevision(value.revisions.scoreState) ||
    !record(value.desk)
  )
    return null;
  const item = value.desk;
  if (!record(item)) return null;
  const count = safeInteger(item.count);
  const bytes = safeInteger(item.bytes);
  if (
    item.name !== 'desk' ||
    item.key !== liveMatchDeskItemKey(scope, generation) ||
    item.type !== 'string' ||
    count === null ||
    count < 0 ||
    count > LIVE_MATCH_MAX_FIXTURES ||
    bytes === null ||
    bytes < 0 ||
    bytes > LIVE_MATCH_MAX_DESK_BYTES ||
    typeof item.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(item.sha256)
  )
    return null;
  return value as unknown as MatchDeskPublication;
}

export function parseLiveMatchDeskPublicationV3(
  value: unknown,
  scope: MatchScope,
): MatchDeskPublication | null {
  return parseDeskPublication(
    typeof value === 'string' ? value : value === null ? null : canonicalJson(value),
    scope,
  );
}

function detailItemKeyMatches(
  key: unknown,
  scope: MatchScope,
  fixtureId: number,
  sha256: string,
): key is string {
  return (
    typeof key === 'string' &&
    new RegExp(
      `^llm:data:v3:fpl:live-match:detail:${scope.season}:${scope.eventId}:[1-9][0-9]*:${fixtureId}:${sha256}$`,
    ).test(key)
  );
}

function parseDetailPublication(
  raw: string | null,
  scope: MatchScope,
): MatchDetailPublication | null {
  if (raw !== null && Buffer.byteLength(raw, 'utf8') > LIVE_MATCH_MAX_PUBLICATION_BYTES)
    return null;
  const value = parseJson(raw);
  if (!record(value)) return null;
  const generation = safeInteger(value.generation);
  const observedDeskGeneration = safeInteger(value.observedDeskGeneration);
  if (
    value.contractVersion !== LIVE_MATCHES_CONTRACT_VERSION ||
    typeof value.publicationId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(value.publicationId) ||
    generation === null ||
    generation <= 0 ||
    value.season !== scope.season ||
    value.eventId !== scope.eventId ||
    typeof value.finalized !== 'boolean' ||
    observedDeskGeneration === null ||
    observedDeskGeneration <= 0 ||
    typeof value.fixtureIdentityRevision !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.fixtureIdentityRevision) ||
    !validIso(value.sourceCheckedAt) ||
    !validIso(value.publishedAt) ||
    (value.checkpointedAt !== null && !validIso(value.checkpointedAt)) ||
    (value.expectedNextCheckAt !== null && !validIso(value.expectedNextCheckAt)) ||
    (value.staleAt !== null && !validIso(value.staleAt)) ||
    !validRevision(value.detail) ||
    !Array.isArray(value.fixtures) ||
    value.fixtures.length > LIVE_MATCH_MAX_FIXTURES
  )
    return null;
  const fixtures = value.fixtures;
  if (
    new Set(fixtures.map((item) => (record(item) ? item.fixtureId : null))).size !==
      fixtures.length ||
    fixtures.reduce(
      (total, item) =>
        total + (record(item) && safeInteger(item.bytes) !== null ? Number(item.bytes) : 0),
      0,
    ) > LIVE_MATCH_MAX_DETAIL_TOTAL_BYTES ||
    !fixtures.every(
      (item) =>
        record(item) &&
        safeInteger(item.fixtureId) !== null &&
        (safeInteger(item.fixtureId) as number) > 0 &&
        item.type === 'string' &&
        safeInteger(item.count) !== null &&
        (safeInteger(item.count) as number) >= 0 &&
        (safeInteger(item.count) as number) <= LIVE_MATCH_MAX_PLAYERS_PER_FIXTURE &&
        safeInteger(item.bytes) !== null &&
        (safeInteger(item.bytes) as number) >= 0 &&
        (safeInteger(item.bytes) as number) <= LIVE_MATCH_MAX_DETAIL_ITEM_BYTES &&
        typeof item.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(item.sha256) &&
        detailItemKeyMatches(item.key, scope, item.fixtureId as number, item.sha256),
    )
  )
    return null;
  return value as unknown as MatchDetailPublication;
}

export function parseLiveMatchDetailPublicationV3(
  value: unknown,
  scope: MatchScope,
): MatchDetailPublication | null {
  return parseDetailPublication(
    typeof value === 'string' ? value : value === null ? null : canonicalJson(value),
    scope,
  );
}

async function readDeskPointerWithRaw(
  redis: Redis,
  scope: MatchScope,
  pointer: 'active' | 'previous',
): Promise<MatchDeskActiveFence> {
  const observed = (await redis.get(liveMatchDeskKey(scope, pointer))) ?? '';
  const publication = parseDeskPublication(observed, scope);
  if (!publication) return { observed, read: null };
  const [payload, metadata] = await redis.mget(
    publication.desk.key,
    metadataKey(publication.desk.key),
  );
  if (
    payload === null ||
    metadata !== itemMetadata(publication.desk) ||
    Buffer.byteLength(payload, 'utf8') !== publication.desk.bytes ||
    contentHash(parseJson(payload)) !== publication.desk.sha256
  )
    return { observed, read: null };
  const value = parseJson(payload);
  if (!validDeskPayload(value, scope.eventId) || value.length !== publication.desk.count) {
    return { observed, read: null };
  }
  return {
    observed,
    read: {
      publication,
      fixtures: value,
      servedFrom: pointer === 'active' ? 'REDIS_CURRENT' : 'REDIS_PREVIOUS',
    },
  };
}

async function readDeskPointer(
  redis: Redis,
  scope: MatchScope,
  pointer: 'active' | 'previous',
): Promise<MatchDeskRead | null> {
  return (await readDeskPointerWithRaw(redis, scope, pointer)).read;
}

async function readDetailPointer(
  redis: Redis,
  scope: MatchScope,
  pointer: 'active' | 'previous',
): Promise<MatchDetailRead | null> {
  const publicationRaw = await redis.get(liveMatchDetailKey(scope, pointer));
  const publication = parseDetailPublication(publicationRaw, scope);
  if (!publication) return null;
  const manifest = parseDetailPublication(
    await redis.get(liveMatchDetailManifestKey(scope, publication.generation)),
    scope,
  );
  if (!manifest || canonicalJson(manifest) !== canonicalJson(publication)) return null;
  const keys: string[] = [];
  for (const item of publication.fixtures) keys.push(item.key, metadataKey(item.key));
  const values = keys.length > 0 ? await redis.mget(...keys) : [];
  const fixtures: MatchFixtureDetail[] = [];
  for (let index = 0; index < publication.fixtures.length; index += 1) {
    const item = publication.fixtures[index];
    if (!item) return null;
    const payload = values[index * 2];
    const metadata = values[index * 2 + 1];
    if (
      payload === null ||
      metadata !== itemMetadata(item) ||
      Buffer.byteLength(payload, 'utf8') !== item.bytes ||
      contentHash(parseJson(payload)) !== item.sha256
    )
      return null;
    const players = parseJson(payload);
    if (!validDetailPayload(players) || players.length !== item.count) return null;
    fixtures.push({ fixtureId: item.fixtureId, players });
  }
  return {
    publication,
    fixtures,
    servedFrom: pointer === 'active' ? 'REDIS_CURRENT' : 'REDIS_PREVIOUS',
  };
}

async function stableDeskActiveForPromotion(
  redis: Redis,
  scope: MatchScope,
): Promise<{ observed: string; validated: MatchDeskRead | null }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = (await redis.get(liveMatchDeskKey(scope, 'active'))) ?? '';
    const validated = await readDeskPointer(redis, scope, 'active');
    const after = (await redis.get(liveMatchDeskKey(scope, 'active'))) ?? '';
    if (before === after) return { observed: after, validated };
  }
  throw new CacheError(
    'Live Match desk current changed during validation',
    'LIVE_MATCH_PROMOTE_CHANGED',
  );
}

async function stableDetailActiveForPromotion(
  redis: Redis,
  scope: MatchScope,
): Promise<MatchDetailActiveFence> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = (await redis.get(liveMatchDetailKey(scope, 'active'))) ?? '';
    const validated = await readDetailPointer(redis, scope, 'active');
    const after = (await redis.get(liveMatchDetailKey(scope, 'active'))) ?? '';
    if (before === after) return { observed: after, read: validated };
  }
  throw new CacheError(
    'Live Match detail current changed during validation',
    'LIVE_MATCH_PROMOTE_CHANGED',
  );
}

export async function readLiveMatchDeskV3(input: {
  readonly season: string;
  readonly eventId: number;
  readonly redis?: Redis;
}): Promise<MatchDeskRead | null> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  return (
    (await readDeskPointer(redis, scope, 'active')) ?? readDeskPointer(redis, scope, 'previous')
  );
}

/** Exact pointer read for protected diagnostics and repair tooling. */
export async function readLiveMatchDeskPointerV3(
  input: {
    readonly season: string;
    readonly eventId: number;
    readonly redis?: Redis;
  },
  pointer: 'active' | 'previous',
): Promise<MatchDeskRead | null> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  return readDeskPointer(redis, scope, pointer);
}

/** Capture the active desk pointer before a provider observation begins. */
export async function readLiveMatchDeskFenceV3(input: {
  readonly season: string;
  readonly eventId: number;
  readonly redis?: Redis;
}): Promise<MatchDeskActiveFence> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  return readDeskPointerWithRaw(redis, scope, 'active');
}

export async function readLiveMatchDetailV3(input: {
  readonly season: string;
  readonly eventId: number;
  readonly redis?: Redis;
}): Promise<MatchDetailRead | null> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  return (
    (await readDetailPointer(redis, scope, 'active')) ?? readDetailPointer(redis, scope, 'previous')
  );
}

/** Exact pointer read for protected diagnostics and repair tooling. */
export async function readLiveMatchDetailPointerV3(
  input: {
    readonly season: string;
    readonly eventId: number;
    readonly redis?: Redis;
  },
  pointer: 'active' | 'previous',
): Promise<MatchDetailRead | null> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  return readDetailPointer(redis, scope, pointer);
}

/** Capture the active detail pointer before a provider observation begins. */
export async function readLiveMatchDetailFenceV3(input: {
  readonly season: string;
  readonly eventId: number;
  readonly redis?: Redis;
}): Promise<MatchDetailActiveFence> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  return stableDetailActiveForPromotion(redis, scope);
}

export async function setLiveMatchActiveEventV3(input: {
  readonly season: string;
  readonly eventId: number;
  readonly redis?: Redis;
}): Promise<void> {
  assertScope(input);
  const redis = input.redis ?? (await redisSingleton.getClient());
  const selected = Number(
    await redis.eval(
      SET_ACTIVE_EVENT_LUA,
      1,
      liveMatchActiveEventKey(input.season),
      String(input.eventId),
    ),
  );
  if (!Number.isSafeInteger(selected) || selected < input.eventId) {
    throw new CacheError(
      'Live Matches V3 active event promotion failed',
      'LIVE_MATCH_ACTIVE_EVENT_FAILED',
    );
  }
}

export async function publishLiveMatchDeskV3(input: {
  readonly season: string;
  readonly eventId: number;
  readonly state: MatchLifecycleState;
  readonly fixtures: readonly MatchDeskFixture[];
  readonly sourceCheckedAt: Date | string;
  readonly expectedNextCheckAt?: Date | string | null;
  readonly staleAt?: Date | string | null;
  readonly previous?: MatchDeskRead | null;
  /** Exact active pointer captured before the upstream observation started. */
  readonly observedActive?: MatchDeskActiveFence;
  readonly generationFloor?: number;
  readonly redis?: Redis;
}): Promise<{
  publication: MatchDeskPublication;
  previous: MatchDeskPublication | null;
  published: boolean;
}> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  assertDeskLimits(input.fixtures);
  if (!validDeskPayload(input.fixtures, scope.eventId)) {
    throw new CacheError('Invalid Live Match desk payload', 'LIVE_MATCH_PAYLOAD_INVALID');
  }
  const redis = input.redis ?? (await redisSingleton.getClient());
  const allocation = await allocateGeneration(
    redis,
    liveMatchDeskKey(scope, 'sequence'),
    Math.max(input.generationFloor ?? 0, input.previous?.publication.generation ?? 0),
  );
  const sourceCheckedAt = sourceDate(input.sourceCheckedAt);
  const expectedNextCheckAt =
    input.expectedNextCheckAt == null ? null : sourceDate(input.expectedNextCheckAt);
  const staleAt = input.staleAt == null ? null : sourceDate(input.staleAt);
  const previousPublication = input.previous?.publication ?? null;
  const contentUpdatedAt = allocation.now;
  const desk = manifestItem(
    'desk',
    liveMatchDeskItemKey(scope, allocation.generation),
    input.fixtures,
  );
  const publication: MatchDeskPublication = {
    contractVersion: LIVE_MATCHES_CONTRACT_VERSION,
    publicationId: randomUUID(),
    generation: allocation.generation,
    season: scope.season,
    eventId: scope.eventId,
    state: input.state,
    sourceCheckedAt,
    publishedAt: allocation.now,
    checkpointedAt: null,
    expectedNextCheckAt,
    staleAt,
    revisions: {
      lifecycle: revision(
        previousPublication?.revisions.lifecycle,
        { state: input.state },
        contentUpdatedAt,
      ),
      fixtureIdentity: revision(
        previousPublication?.revisions.fixtureIdentity,
        input.fixtures.map((fixture) => ({
          fixtureId: fixture.fixtureId,
          eventId: fixture.eventId,
          homeTeamId: fixture.homeTeamId,
          homeTeamName: fixture.homeTeamName,
          homeTeamShortName: fixture.homeTeamShortName,
          awayTeamId: fixture.awayTeamId,
          awayTeamName: fixture.awayTeamName,
          awayTeamShortName: fixture.awayTeamShortName,
          kickoffTime: fixture.kickoffTime,
        })),
        contentUpdatedAt,
      ),
      scoreState: revision(
        previousPublication?.revisions.scoreState,
        input.fixtures.map((fixture) => ({
          fixtureId: fixture.fixtureId,
          homeScore: fixture.homeScore,
          awayScore: fixture.awayScore,
          minutes: fixture.minutes,
          started: fixture.started,
          finished: fixture.finished,
          finishedProvisional: fixture.finishedProvisional,
        })),
        contentUpdatedAt,
      ),
    },
    desk,
  };
  assertPublicationBytes(publication);
  const payload = canonicalJson(input.fixtures);
  await stage(redis, [{ key: desk.key, payload, item: desk }]);
  const promotionActive = input.observedActive
    ? { observed: input.observedActive.observed, validated: input.observedActive.read }
    : await stableDeskActiveForPromotion(redis, scope);
  const [status, currentRaw] = promotionResult(
    await redis.eval(
      PROMOTE_DESK_LUA,
      4,
      liveMatchDeskKey(scope, 'active'),
      liveMatchDeskKey(scope, 'previous'),
      liveMatchDeskKey(scope, 'sequence'),
      liveMatchDetailKey(scope, 'active'),
      JSON.stringify(publication),
      promotionActive.observed,
      String(LIVE_MATCH_PREVIOUS_TTL_MS),
      String(LIVE_MATCH_FINAL_TTL_MS),
      promotionActive.validated ? promotionActive.validated.publication.publicationId : '',
      promotionActive.validated ? String(promotionActive.validated.publication.generation) : '',
      '0',
      '',
    ),
  );
  if (status === 'stale') {
    const current = parseDeskPublication(currentRaw ?? null, scope);
    if (!current)
      throw new CacheError('Stale desk publication is invalid', 'LIVE_MATCH_PROMOTE_FAILED');
    return { publication: current, previous: current, published: false };
  }
  if (status === 'changed' || status === 'detail_changed')
    throw new CacheError(
      'Live Match desk current changed during promotion',
      'LIVE_MATCH_PROMOTE_CHANGED',
    );
  if (status !== 'published')
    throw new CacheError(
      `Live Match desk promotion failed: ${status}`,
      'LIVE_MATCH_PROMOTE_FAILED',
    );
  return {
    publication,
    previous: promotionActive.validated
      ? parseDeskPublication(currentRaw ?? null, scope)
      : (input.previous?.publication ?? null),
    published: true,
  };
}

export async function publishLiveMatchDetailV3(input: {
  readonly season: string;
  readonly eventId: number;
  readonly observedDeskGeneration: number;
  readonly fixtureIdentityRevision: string;
  readonly fixtures: readonly MatchFixtureDetail[];
  readonly sourceCheckedAt: Date | string;
  readonly expectedNextCheckAt?: Date | string | null;
  readonly staleAt?: Date | string | null;
  readonly previous?: MatchDetailRead | null;
  /** Exact active detail pointer captured before the upstream observation. */
  readonly observedActive?: MatchDetailActiveFence;
  readonly generationFloor?: number;
  readonly finalized?: boolean;
  readonly redis?: Redis;
}): Promise<{
  publication: MatchDetailPublication;
  previous: MatchDetailPublication | null;
  published: boolean;
}> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  if (!Number.isSafeInteger(input.observedDeskGeneration) || input.observedDeskGeneration <= 0) {
    throw new CacheError(
      'Invalid observed desk generation',
      'LIVE_MATCH_DETAIL_DESK_GENERATION_INVALID',
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.fixtureIdentityRevision)) {
    throw new CacheError(
      'Invalid detail fixture identity revision',
      'LIVE_MATCH_DETAIL_REVISION_INVALID',
    );
  }
  assertDetailLimits(input.fixtures);
  if (
    new Set(input.fixtures.map((fixture) => fixture.fixtureId)).size !== input.fixtures.length ||
    input.fixtures.some(
      (fixture) =>
        !Number.isSafeInteger(fixture.fixtureId) ||
        fixture.fixtureId <= 0 ||
        !validDetailPayload(fixture.players),
    )
  ) {
    throw new CacheError('Invalid Live Match detail payload', 'LIVE_MATCH_PAYLOAD_INVALID');
  }
  const redis = input.redis ?? (await redisSingleton.getClient());
  const allocation = await allocateGeneration(
    redis,
    liveMatchDetailKey(scope, 'sequence'),
    Math.max(input.generationFloor ?? 0, input.previous?.publication.generation ?? 0),
  );
  const sourceCheckedAt = sourceDate(input.sourceCheckedAt);
  const expectedNextCheckAt =
    input.expectedNextCheckAt == null ? null : sourceDate(input.expectedNextCheckAt);
  const staleAt = input.staleAt == null ? null : sourceDate(input.staleAt);
  const previousPublication = input.previous?.publication ?? null;
  const detailRevision = revision(previousPublication?.detail, input.fixtures, allocation.now);
  const previousByHash = new Map<string, MatchDetailItem>();
  for (const item of previousPublication?.fixtures ?? [])
    previousByHash.set(`${item.fixtureId}:${item.sha256}`, item);
  const sortedFixtures = [...input.fixtures].sort(
    (left, right) => left.fixtureId - right.fixtureId,
  );
  const descriptors = sortedFixtures
    .map((fixture) => {
      const payloadHash = contentHash(fixture.players);
      return (
        previousByHash.get(`${fixture.fixtureId}:${payloadHash}`) ??
        detailItem(scope, allocation.generation, fixture.fixtureId, fixture.players)
      );
    })
    .sort((left, right) => left.fixtureId - right.fixtureId);
  const publication: MatchDetailPublication = {
    contractVersion: LIVE_MATCHES_CONTRACT_VERSION,
    publicationId: randomUUID(),
    generation: allocation.generation,
    season: scope.season,
    eventId: scope.eventId,
    finalized: input.finalized === true,
    observedDeskGeneration: input.observedDeskGeneration,
    fixtureIdentityRevision: input.fixtureIdentityRevision,
    sourceCheckedAt,
    publishedAt: allocation.now,
    checkpointedAt: null,
    expectedNextCheckAt,
    staleAt,
    detail: detailRevision,
    fixtures: descriptors,
  };
  assertPublicationBytes(publication);
  const values = sortedFixtures
    .map((fixture, index) => ({
      key: descriptors[index]?.key,
      payload: canonicalJson(fixture.players),
      item: descriptors[index],
    }))
    .filter(
      (value): value is { key: string; payload: string; item: MatchDetailItem } =>
        value.key !== undefined && value.item !== undefined,
    );
  await stage(redis, values);
  const promotionActive = input.observedActive
    ? { observed: input.observedActive.observed, read: input.observedActive.read }
    : await stableDetailActiveForPromotion(redis, scope);
  const [status, currentRaw] = promotionResult(
    await redis.eval(
      PROMOTE_DETAIL_LUA,
      4,
      liveMatchDetailKey(scope, 'active'),
      liveMatchDetailKey(scope, 'previous'),
      liveMatchDetailKey(scope, 'sequence'),
      liveMatchDeskKey(scope, 'active'),
      JSON.stringify(publication),
      promotionActive.observed,
      String(LIVE_MATCH_PREVIOUS_TTL_MS),
      input.finalized === true ? '1' : '0',
      String(LIVE_MATCH_FINAL_TTL_MS),
      promotionActive.read ? promotionActive.read.publication.publicationId : '',
      promotionActive.read ? String(promotionActive.read.publication.generation) : '',
    ),
  );
  if (status === 'stale') {
    const current = parseDetailPublication(currentRaw ?? null, scope);
    if (!current)
      throw new CacheError('Stale detail publication is invalid', 'LIVE_MATCH_PROMOTE_FAILED');
    return { publication: current, previous: current, published: false };
  }
  if (status === 'changed' || status === 'desk_changed')
    throw new CacheError(
      'Live Match detail or desk current changed during promotion',
      'LIVE_MATCH_PROMOTE_CHANGED',
    );
  if (status !== 'published')
    throw new CacheError(
      `Live Match detail promotion failed: ${status}`,
      'LIVE_MATCH_PROMOTE_FAILED',
    );
  return {
    publication,
    previous: promotionActive.read
      ? parseDetailPublication(currentRaw ?? null, scope)
      : (input.previous?.publication ?? null),
    published: true,
  };
}

function samePublicationItem(
  left: Readonly<{ key: string; type: string; count: number; bytes: number; sha256: string }>,
  right: Readonly<{ key: string; type: string; count: number; bytes: number; sha256: string }>,
): boolean {
  return (
    left.key === right.key &&
    left.type === right.type &&
    left.count === right.count &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256
  );
}

/** Restore the exact desk publication identity from a validated PostgreSQL checkpoint. */
export async function restoreLiveMatchDeskCheckpointV3(input: {
  readonly checkpoint: MatchDeskRead;
  /** Optional active-detail fence, required by operator desk rebuilds. */
  readonly observedDetail?: MatchDetailActiveFence | null;
  /** Future/pre-deadline repairs must not make the eventless pointer live. */
  readonly promoteActiveEvent?: boolean;
  readonly redis?: Redis;
}): Promise<{ publication: MatchDeskPublication; published: boolean }> {
  const { publication, fixtures } = input.checkpoint;
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  assertScope(scope);
  assertDeskLimits(fixtures);
  const parsed = parseLiveMatchDeskPublicationV3(publication, scope);
  const expected = manifestItem(
    'desk',
    liveMatchDeskItemKey(scope, publication.generation),
    fixtures,
  );
  if (
    !parsed ||
    canonicalJson(parsed) !== canonicalJson(publication) ||
    !validDeskPayload(fixtures, scope.eventId) ||
    !samePublicationItem(publication.desk, expected)
  ) {
    throw new CacheError(
      'Live Match desk checkpoint does not match its manifest',
      'LIVE_MATCH_CHECKPOINT_INVALID',
    );
  }
  const redis = input.redis ?? (await redisSingleton.getClient());
  await stage(
    redis,
    [{ key: publication.desk.key, payload: canonicalJson(fixtures), item: publication.desk }],
    'restore',
  );
  const active = await stableDeskActiveForPromotion(redis, scope);
  const [status] = promotionResult(
    await redis.eval(
      PROMOTE_DESK_LUA,
      4,
      liveMatchDeskKey(scope, 'active'),
      liveMatchDeskKey(scope, 'previous'),
      liveMatchDeskKey(scope, 'sequence'),
      liveMatchDetailKey(scope, 'active'),
      JSON.stringify(publication),
      active.observed,
      String(LIVE_MATCH_PREVIOUS_TTL_MS),
      String(LIVE_MATCH_FINAL_TTL_MS),
      active.validated?.publication.publicationId ?? '',
      active.validated ? String(active.validated.publication.generation) : '',
      'restore',
      input.observedDetail ? '1' : '0',
      input.observedDetail?.observed ?? '',
    ),
  );
  if (status === 'changed' || status === 'detail_changed') {
    throw new CacheError(
      'Live Match desk changed during checkpoint restore',
      'LIVE_MATCH_CHECKPOINT_RESTORE_CHANGED',
    );
  }
  if (status !== 'published' && status !== 'stale') {
    throw new CacheError(
      `Live Match desk checkpoint restore failed: ${status}`,
      'LIVE_MATCH_CHECKPOINT_RESTORE_FAILED',
    );
  }
  const current = await readDeskPointer(redis, scope, 'active');
  if (!current) {
    throw new CacheError(
      'Live Match desk checkpoint restore produced no valid current',
      'LIVE_MATCH_CHECKPOINT_RESTORE_FAILED',
    );
  }
  if (input.promoteActiveEvent !== false) {
    await setLiveMatchActiveEventV3({ ...scope, redis });
  }
  return { publication: current.publication, published: status === 'published' };
}

/** Restore the exact fixture-detail publication and immutable item keys from PostgreSQL. */
export async function restoreLiveMatchDetailCheckpointV3(input: {
  readonly checkpoint: MatchDetailRead;
  readonly redis?: Redis;
}): Promise<{ publication: MatchDetailPublication; published: boolean }> {
  const { publication, fixtures } = input.checkpoint;
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  assertScope(scope);
  assertDetailLimits(fixtures);
  const parsed = parseLiveMatchDetailPublicationV3(publication, scope);
  const sorted = [...fixtures].sort((left, right) => left.fixtureId - right.fixtureId);
  if (
    !parsed ||
    canonicalJson(parsed) !== canonicalJson(publication) ||
    !isValidLiveMatchDetailCheckpointPayloadV3(sorted) ||
    publication.fixtures.length !== sorted.length ||
    publication.detail.revision !== contentHash(sorted)
  ) {
    throw new CacheError(
      'Live Match detail checkpoint does not match its manifest',
      'LIVE_MATCH_CHECKPOINT_INVALID',
    );
  }
  const values = sorted.map((fixture, index) => {
    const item = publication.fixtures[index];
    if (!item) {
      throw new CacheError(
        'Live Match detail checkpoint fixture is missing from manifest',
        'LIVE_MATCH_CHECKPOINT_INVALID',
      );
    }
    const itemGeneration = Number(item.key.split(':').at(-3));
    if (!Number.isSafeInteger(itemGeneration) || itemGeneration <= 0) {
      throw new CacheError(
        `Live Match detail checkpoint fixture ${fixture.fixtureId} has an invalid item generation`,
        'LIVE_MATCH_CHECKPOINT_INVALID',
      );
    }
    const expected = detailItem(scope, itemGeneration, fixture.fixtureId, fixture.players);
    if (item.fixtureId !== fixture.fixtureId || !samePublicationItem(item, expected)) {
      throw new CacheError(
        `Live Match detail checkpoint fixture ${fixture.fixtureId} does not match manifest`,
        'LIVE_MATCH_CHECKPOINT_INVALID',
      );
    }
    return { key: item.key, payload: canonicalJson(fixture.players), item };
  });
  const redis = input.redis ?? (await redisSingleton.getClient());
  await stage(redis, values, 'restore');
  const active = await stableDetailActiveForPromotion(redis, scope);
  const [status] = promotionResult(
    await redis.eval(
      PROMOTE_DETAIL_LUA,
      4,
      liveMatchDetailKey(scope, 'active'),
      liveMatchDetailKey(scope, 'previous'),
      liveMatchDetailKey(scope, 'sequence'),
      liveMatchDeskKey(scope, 'active'),
      JSON.stringify(publication),
      active.observed,
      String(LIVE_MATCH_PREVIOUS_TTL_MS),
      publication.finalized ? '1' : '0',
      String(LIVE_MATCH_FINAL_TTL_MS),
      active.read?.publication.publicationId ?? '',
      active.read ? String(active.read.publication.generation) : '',
      'restore',
    ),
  );
  if (status === 'changed' || status === 'desk_changed') {
    throw new CacheError(
      'Live Match detail or desk changed during checkpoint restore',
      'LIVE_MATCH_CHECKPOINT_RESTORE_CHANGED',
    );
  }
  if (status !== 'published' && status !== 'stale') {
    throw new CacheError(
      `Live Match detail checkpoint restore failed: ${status}`,
      'LIVE_MATCH_CHECKPOINT_RESTORE_FAILED',
    );
  }
  const current = await readDetailPointer(redis, scope, 'active');
  if (!current) {
    throw new CacheError(
      'Live Match detail checkpoint restore produced no valid current',
      'LIVE_MATCH_CHECKPOINT_RESTORE_FAILED',
    );
  }
  return { publication: current.publication, published: status === 'published' };
}

/** CAS-promote one validated previous pointer; a valid final current is never rolled back. */
export async function promotePreviousLiveMatchV3(input: {
  readonly season: string;
  readonly eventId: number;
  readonly kind: 'desk' | 'detail';
  /** Optional atomic detail fence used when rolling a desk pointer back. */
  readonly observedDetail?: MatchDetailActiveFence | null;
  /** Future desk repairs must not make the eventless pointer live. */
  readonly promoteActiveEvent?: boolean;
  readonly redis?: Redis;
}): Promise<{
  status: 'promoted' | 'changed' | 'unavailable';
  publication: MatchDeskPublication | MatchDetailPublication | null;
}> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  if (input.kind === 'desk') {
    const previous = await readDeskPointer(redis, scope, 'previous');
    if (!previous) return { status: 'unavailable', publication: null };
    const active = await stableDeskActiveForPromotion(redis, scope);
    const [status] = promotionResult(
      await redis.eval(
        PROMOTE_DESK_LUA,
        4,
        liveMatchDeskKey(scope, 'active'),
        liveMatchDeskKey(scope, 'previous'),
        liveMatchDeskKey(scope, 'sequence'),
        liveMatchDetailKey(scope, 'active'),
        JSON.stringify(previous.publication),
        active.observed,
        String(LIVE_MATCH_PREVIOUS_TTL_MS),
        String(LIVE_MATCH_FINAL_TTL_MS),
        active.validated?.publication.publicationId ?? '',
        active.validated ? String(active.validated.publication.generation) : '',
        'rollback',
        input.observedDetail ? '1' : '0',
        input.observedDetail?.observed ?? '',
      ),
    );
    if (status === 'changed' || status === 'detail_changed' || status === 'stale')
      return { status: 'changed', publication: null };
    if (status !== 'published')
      throw new CacheError(
        `Live Match desk rollback failed: ${status}`,
        'LIVE_MATCH_REPAIR_FAILED',
      );
    const promoted = await readDeskPointer(redis, scope, 'active');
    if (!promoted || promoted.publication.publicationId !== previous.publication.publicationId)
      throw new CacheError(
        'Live Match desk rollback verification failed',
        'LIVE_MATCH_REPAIR_FAILED',
      );
    if (input.promoteActiveEvent !== false) {
      await setLiveMatchActiveEventV3({ ...scope, redis });
    }
    return { status: 'promoted', publication: promoted.publication };
  }
  const previous = await readDetailPointer(redis, scope, 'previous');
  if (!previous) return { status: 'unavailable', publication: null };
  const active = await stableDetailActiveForPromotion(redis, scope);
  const [status] = promotionResult(
    await redis.eval(
      PROMOTE_DETAIL_LUA,
      4,
      liveMatchDetailKey(scope, 'active'),
      liveMatchDetailKey(scope, 'previous'),
      liveMatchDetailKey(scope, 'sequence'),
      liveMatchDeskKey(scope, 'active'),
      JSON.stringify(previous.publication),
      active.observed,
      String(LIVE_MATCH_PREVIOUS_TTL_MS),
      previous.publication.finalized ? '1' : '0',
      String(LIVE_MATCH_FINAL_TTL_MS),
      active.read?.publication.publicationId ?? '',
      active.read ? String(active.read.publication.generation) : '',
      'rollback',
    ),
  );
  if (status === 'changed' || status === 'desk_changed' || status === 'stale')
    return { status: 'changed', publication: null };
  if (status !== 'published')
    throw new CacheError(
      `Live Match detail rollback failed: ${status}`,
      'LIVE_MATCH_REPAIR_FAILED',
    );
  const promoted = await readDetailPointer(redis, scope, 'active');
  if (!promoted || promoted.publication.publicationId !== previous.publication.publicationId)
    throw new CacheError(
      'Live Match detail rollback verification failed',
      'LIVE_MATCH_REPAIR_FAILED',
    );
  return { status: 'promoted', publication: promoted.publication };
}

export async function touchLiveMatchDeskV3(input: {
  readonly publication: MatchDeskPublication;
  readonly sourceCheckedAt: Date | string;
  readonly expectedNextCheckAt?: Date | string | null;
  readonly staleAt?: Date | string | null;
  /** Exact active desk pointer captured before the upstream observation. */
  readonly observedActive?: MatchDeskActiveFence;
  readonly redis?: Redis;
}): Promise<MatchDeskPublication | null> {
  const scope = { season: input.publication.season, eventId: input.publication.eventId } as const;
  const redis = input.redis ?? (await redisSingleton.getClient());
  const observedActive = input.observedActive ?? (await stableDeskActiveForPromotion(redis, scope));
  const [status, raw] = promotionResult(
    await redis.eval(
      TOUCH_ONE_LUA,
      1,
      liveMatchDeskKey(scope, 'active'),
      input.publication.publicationId,
      String(input.publication.generation),
      sourceDate(input.sourceCheckedAt),
      input.expectedNextCheckAt == null ? '' : sourceDate(input.expectedNextCheckAt),
      input.staleAt == null ? '' : sourceDate(input.staleAt),
      observedActive.observed,
    ),
  );
  if (status !== 'touched') return null;
  return parseDeskPublication(raw ?? null, scope);
}

export async function touchLiveMatchDetailV3(input: {
  readonly publication: MatchDetailPublication;
  readonly sourceCheckedAt: Date | string;
  readonly expectedNextCheckAt?: Date | string | null;
  readonly staleAt?: Date | string | null;
  /** Exact active detail pointer captured before the upstream observation. */
  readonly observedActive?: MatchDetailActiveFence;
  readonly redis?: Redis;
}): Promise<MatchDetailPublication | null> {
  const scope = { season: input.publication.season, eventId: input.publication.eventId } as const;
  const redis = input.redis ?? (await redisSingleton.getClient());
  const observedActive =
    input.observedActive ?? (await stableDetailActiveForPromotion(redis, scope));
  const [status, raw] = promotionResult(
    await redis.eval(
      TOUCH_DETAIL_LUA,
      2,
      liveMatchDetailKey(scope, 'active'),
      liveMatchDetailManifestKey(scope, input.publication.generation),
      input.publication.publicationId,
      String(input.publication.generation),
      sourceDate(input.sourceCheckedAt),
      input.expectedNextCheckAt == null ? '' : sourceDate(input.expectedNextCheckAt),
      input.staleAt == null ? '' : sourceDate(input.staleAt),
      observedActive.observed,
    ),
  );
  if (status !== 'touched') return null;
  return parseDetailPublication(raw ?? null, scope);
}

export type LiveMatchFinalLeaseResult = Readonly<{
  status: 'renewed' | 'changed' | 'invalid' | 'missing';
  ttlMs: number | null;
}>;

/** Renew a complete FINAL desk without rewriting the desk manifest. */
export async function renewLiveMatchDeskFinalLeaseV3(input: {
  readonly publication: MatchDeskPublication;
  readonly observedRaw?: string;
  readonly redis?: Redis;
}): Promise<LiveMatchFinalLeaseResult> {
  const publication = input.publication;
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  assertScope(scope);
  if (publication.state !== 'FINALIZED') return { status: 'invalid', ttlMs: null };
  const redis = input.redis ?? (await redisSingleton.getClient());
  const observedRaw =
    input.observedRaw ?? (await redis.get(liveMatchDeskKey(scope, 'active'))) ?? '';
  const current = await readDeskPointer(redis, scope, 'active');
  if (
    !current ||
    current.servedFrom !== 'REDIS_CURRENT' ||
    current.publication.publicationId !== publication.publicationId ||
    current.publication.generation !== publication.generation ||
    current.publication.state !== 'FINALIZED'
  ) {
    return { status: observedRaw === '' ? 'missing' : 'changed', ttlMs: null };
  }
  const rawAfterValidation = (await redis.get(liveMatchDeskKey(scope, 'active'))) ?? '';
  if (rawAfterValidation !== observedRaw) return { status: 'changed', ttlMs: null };
  const result = promotionResult(
    await redis.eval(
      RENEW_DESK_FINAL_LEASE_LUA,
      1,
      liveMatchDeskKey(scope, 'active'),
      observedRaw,
      publication.publicationId,
      String(publication.generation),
      String(LIVE_MATCH_FINAL_TTL_MS),
    ),
  );
  const status = result[0];
  return {
    status:
      status === 'renewed' || status === 'changed' || status === 'invalid' || status === 'missing'
        ? status
        : 'invalid',
    ttlMs: status === 'renewed' ? Number(result[1] ?? 0) : null,
  };
}

/** Renew every immutable FINAL detail item and its generation manifest. */
export async function renewLiveMatchDetailFinalLeaseV3(input: {
  readonly publication: MatchDetailPublication;
  readonly observedRaw?: string;
  readonly redis?: Redis;
}): Promise<LiveMatchFinalLeaseResult> {
  const publication = input.publication;
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  assertScope(scope);
  if (!publication.finalized) return { status: 'invalid', ttlMs: null };
  const redis = input.redis ?? (await redisSingleton.getClient());
  const observedRaw =
    input.observedRaw ?? (await redis.get(liveMatchDetailKey(scope, 'active'))) ?? '';
  const current = await readDetailPointer(redis, scope, 'active');
  if (
    !current ||
    current.servedFrom !== 'REDIS_CURRENT' ||
    current.publication.publicationId !== publication.publicationId ||
    current.publication.generation !== publication.generation ||
    !current.publication.finalized
  ) {
    return { status: observedRaw === '' ? 'missing' : 'changed', ttlMs: null };
  }
  const rawAfterValidation = (await redis.get(liveMatchDetailKey(scope, 'active'))) ?? '';
  if (rawAfterValidation !== observedRaw) return { status: 'changed', ttlMs: null };
  const result = promotionResult(
    await redis.eval(
      RENEW_DETAIL_FINAL_LEASE_LUA,
      2,
      liveMatchDetailKey(scope, 'active'),
      liveMatchDetailManifestKey(scope, publication.generation),
      observedRaw,
      publication.publicationId,
      String(publication.generation),
      String(LIVE_MATCH_FINAL_TTL_MS),
    ),
  );
  const status = result[0];
  return {
    status:
      status === 'renewed' || status === 'changed' || status === 'invalid' || status === 'missing'
        ? status
        : 'invalid',
    ttlMs: status === 'renewed' ? Number(result[1] ?? 0) : null,
  };
}

export async function markLiveMatchDeskCheckpointedV3(
  publication: MatchDeskPublication,
  checkpointedAt: Date | string,
  redisClient?: Redis,
): Promise<MatchDeskPublication | null> {
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  const redis = redisClient ?? (await redisSingleton.getClient());
  const [status, raw] = promotionResult(
    await redis.eval(
      CHECKPOINT_ONE_LUA,
      2,
      liveMatchDeskKey(scope, 'active'),
      liveMatchCheckpointLastKey(scope, 'desk'),
      publication.publicationId,
      String(publication.generation),
      sourceDate(checkpointedAt),
      '172800',
    ),
  );
  return status === 'checkpointed' ? parseDeskPublication(raw ?? null, scope) : null;
}

export async function markLiveMatchDetailCheckpointedV3(
  publication: MatchDetailPublication,
  checkpointedAt: Date | string,
  redisClient?: Redis,
): Promise<MatchDetailPublication | null> {
  const scope = { season: publication.season, eventId: publication.eventId } as const;
  const redis = redisClient ?? (await redisSingleton.getClient());
  const [status, raw] = promotionResult(
    await redis.eval(
      CHECKPOINT_DETAIL_LUA,
      3,
      liveMatchDetailKey(scope, 'active'),
      liveMatchDetailManifestKey(scope, publication.generation),
      liveMatchCheckpointLastKey(scope, 'detail'),
      publication.publicationId,
      String(publication.generation),
      sourceDate(checkpointedAt),
      '172800',
    ),
  );
  return status === 'checkpointed' ? parseDetailPublication(raw ?? null, scope) : null;
}

export async function readLiveMatchCheckpointLastAtV3(input: {
  readonly kind: 'desk' | 'detail';
  readonly season: string;
  readonly eventId: number;
  readonly redis?: Redis;
}): Promise<string | null> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  const value = parseJson(await redis.get(liveMatchCheckpointLastKey(scope, input.kind)));
  if (
    !record(value) ||
    value.contractVersion !== LIVE_MATCHES_CONTRACT_VERSION ||
    value.kind !== input.kind ||
    value.season !== input.season ||
    value.eventId !== input.eventId ||
    typeof value.publicationId !== 'string' ||
    safeInteger(value.generation) === null ||
    (safeInteger(value.generation) as number) <= 0 ||
    !validIso(value.checkpointedAt)
  ) {
    return null;
  }
  return value.checkpointedAt;
}

function desiredFromRaw(
  value: unknown,
  kind: 'desk' | 'detail',
  scope: MatchScope,
): MatchCheckpointDesired | null {
  if (!record(value)) return null;
  const generation = safeInteger(value.generation);
  if (
    value.contractVersion !== LIVE_MATCHES_CONTRACT_VERSION ||
    value.kind !== kind ||
    value.season !== scope.season ||
    value.eventId !== scope.eventId ||
    typeof value.publicationId !== 'string' ||
    generation === null ||
    generation <= 0 ||
    !validIso(value.requestedAt) ||
    typeof value.final !== 'boolean' ||
    typeof value.force !== 'boolean'
  )
    return null;
  return value as unknown as MatchCheckpointDesired;
}

export async function setLiveMatchCheckpointDesiredV3(input: {
  readonly kind: 'desk' | 'detail';
  readonly publication: MatchDeskPublication | MatchDetailPublication;
  readonly requestedAt?: Date | string;
  readonly finalized?: boolean;
  readonly force?: boolean;
  /**
   * Seed-only fenced CAS for replacing a stale finalized desired marker. The
   * candidate must itself be finalized and forced; normal workers never pass
   * this field. It applies to either V3 stream because a cutover must replace
   * the old finalized desk and detail checkpoints as one scoped operation.
   */
  readonly replaceFinalizedForCutover?: Readonly<{
    readonly expectedPublicationId: string;
    readonly expectedGeneration: number;
  }>;
  readonly redis?: Redis;
}): Promise<MatchCheckpointDesired> {
  const scope = { season: input.publication.season, eventId: input.publication.eventId } as const;
  const redis = input.redis ?? (await redisSingleton.getClient());
  const desired: MatchCheckpointDesired = {
    contractVersion: LIVE_MATCHES_CONTRACT_VERSION,
    kind: input.kind,
    season: scope.season,
    eventId: scope.eventId,
    publicationId: input.publication.publicationId,
    generation: input.publication.generation,
    requestedAt: sourceDate(input.requestedAt ?? new Date()),
    final:
      input.finalized === true ||
      ('finalized' in input.publication && input.publication.finalized === true) ||
      (input.kind === 'desk' &&
        'state' in input.publication &&
        input.publication.state === 'FINALIZED'),
    force: input.force === true,
  };
  const replacement = input.replaceFinalizedForCutover;
  if (replacement !== undefined) {
    if (
      desired.final !== true ||
      desired.force !== true ||
      typeof replacement.expectedPublicationId !== 'string' ||
      replacement.expectedPublicationId.length === 0 ||
      !Number.isSafeInteger(replacement.expectedGeneration) ||
      replacement.expectedGeneration <= 0
    ) {
      throw new CacheError(
        'Invalid finalized Live Matches cutover replacement fence',
        'LIVE_MATCH_CHECKPOINT_DESIRED_INVALID',
      );
    }
  }
  const [status, raw] = promotionResult(
    await redis.eval(
      SET_DESIRED_LUA,
      1,
      liveMatchCheckpointKey(scope, input.kind),
      JSON.stringify(desired),
      '86400',
      replacement === undefined ? '0' : '1',
      replacement?.expectedPublicationId ?? '',
      replacement === undefined ? '' : String(replacement.expectedGeneration),
    ),
  );
  if (status !== 'set' && status !== 'kept') {
    throw new CacheError(
      'Live Matches V3 checkpoint obligation failed',
      'LIVE_MATCH_CHECKPOINT_DESIRED_FAILED',
    );
  }
  const parsed = desiredFromRaw(parseJson(raw ?? null), input.kind, scope);
  if (!parsed)
    throw new CacheError(
      'Stored Live Matches V3 checkpoint obligation is invalid',
      'LIVE_MATCH_CHECKPOINT_DESIRED_INVALID',
    );
  return parsed;
}

export async function readLiveMatchCheckpointDesiredV3(input: {
  readonly kind: 'desk' | 'detail';
  readonly season: string;
  readonly eventId: number;
  readonly redis?: Redis;
}): Promise<MatchCheckpointDesired | null> {
  const scope = { season: input.season, eventId: input.eventId } as const;
  assertScope(scope);
  const redis = input.redis ?? (await redisSingleton.getClient());
  return desiredFromRaw(
    parseJson(await redis.get(liveMatchCheckpointKey(scope, input.kind))),
    input.kind,
    scope,
  );
}

export async function clearLiveMatchCheckpointDesiredV3(
  desired: MatchCheckpointDesired,
  redisClient?: Redis,
): Promise<void> {
  const scope = { season: desired.season, eventId: desired.eventId } as const;
  const redis = redisClient ?? (await redisSingleton.getClient());
  await redis.eval(
    CLEAR_DESIRED_LUA,
    1,
    liveMatchCheckpointKey(scope, desired.kind),
    desired.publicationId,
    String(desired.generation),
  );
}

export function liveMatchPublicationPayload(
  value: readonly MatchDeskFixture[] | readonly MatchFixtureDetail[] | readonly MatchDetailPlayer[],
): { payload: string; bytes: number; sha256: string; count: number } {
  const payload = canonicalJson(value);
  return {
    payload,
    bytes: Buffer.byteLength(payload, 'utf8'),
    sha256: contentHash(value),
    count: value.length,
  };
}

export function isValidLiveMatchDetailItemKey(
  key: string,
  scope: MatchScope,
  fixtureId: number,
  sha256: string,
): boolean {
  return detailItemKeyMatches(key, scope, fixtureId, sha256);
}

export type { MatchScope };
