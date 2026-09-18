import { createHash } from 'node:crypto';

import Redis, { Command as RedisCommand } from 'ioredis';

import { canonicalJson } from '../utils/content-hash';
import { CacheError } from '../utils/errors';
import { redisSingleton } from './singleton';

export const DATA_CACHE_NAMESPACE = 'llm:data';
export const DATA_PUBLICATION_STAGING_TTL_MS = 15 * 60 * 1_000;
export const DATA_PUBLICATION_RETIRED_TTL_MS = 24 * 60 * 60 * 1_000;
/** Producer-side proof version required by durable publication readers. */
export const DATA_PUBLICATION_VALIDATION_VERSION = 1;

export function isDataPublicationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export type DataPublicationDataset = 'fpl:core' | 'fpl:market' | 'fpl:price-changes';
export type MarketSnapshotContextPayload = {
  readonly seasonCode: string;
  readonly snapshotDate: string;
  readonly capturedAt: string;
  readonly latestMutationAt: string;
  readonly sourceEventId: number;
  readonly rowCount: number;
  readonly expectedRowCount: number;
};
export type DataPublicationItemType = 'string';
export type DataPublicationState = 'active';

export interface DataPublicationScope {
  readonly dataset: DataPublicationDataset;
  readonly seasonCode: string;
  readonly eventId?: number;
}

export interface DataPublicationItemInput {
  readonly name: string;
  readonly value: unknown;
}

export interface DataPublicationManifestItem {
  readonly name: string;
  readonly key: string;
  readonly type: DataPublicationItemType;
  readonly count: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DataPublicationManifest {
  readonly dataset: DataPublicationDataset;
  readonly seasonCode: string;
  readonly eventId: number | null;
  readonly revision: number;
  readonly publicationId: string;
  readonly sourceCheckedAt: string;
  /** The last successful source fetch, even when the immutable payload is unchanged. */
  readonly lastSuccessfulFetchAt?: string;
  /** Exact freshness window that requested this publication, when applicable. */
  readonly freshnessWindowId?: number;
  /** All freshness windows joined to this publication, when applicable. */
  readonly freshnessWindowIds?: readonly number[];
  readonly publishedAt: string;
  readonly state: DataPublicationState;
  readonly items: readonly DataPublicationManifestItem[];
}

export interface DataPublicationReadResult {
  readonly manifest: DataPublicationManifest;
  readonly items: Readonly<Record<string, unknown>>;
}

export interface PublishDataRevisionInput extends DataPublicationScope {
  readonly revision: number;
  readonly publicationId: string;
  readonly sourceCheckedAt: Date;
  /** Preserve an immutable canonical timestamp when rebuilding a cache. */
  readonly publishedAt?: Date;
  readonly lastSuccessfulFetchAt?: Date;
  /** Exact freshness window that requested this publication, when applicable. */
  readonly freshnessWindowId?: number;
  /** All freshness windows joined to this publication, when applicable. */
  readonly freshnessWindowIds?: readonly number[];
  readonly state: DataPublicationState;
  readonly items: readonly DataPublicationItemInput[];
}

export interface PublishDataRevisionOptions {
  readonly redis?: Redis;
  /** Stage immutable payloads only; the caller activates DB/outbox first. */
  readonly activate?: boolean;
  readonly beforeActivate?: () => Promise<boolean | void>;
  readonly afterStage?: (manifest: DataPublicationManifest) => Promise<void>;
}

export interface PublishDataRevisionResult {
  readonly status: 'published' | 'stale';
  readonly manifest: DataPublicationManifest;
  readonly previousManifest: DataPublicationManifest | null;
}

type SerializedItem = {
  readonly manifest: DataPublicationManifestItem;
  readonly payload: string;
};

export type DataPublicationDeliveryItem = SerializedItem;

const MANIFEST_FIELDS = [
  'dataset',
  'seasonCode',
  'eventId',
  'revision',
  'publicationId',
  'sourceCheckedAt',
  'publishedAt',
  'state',
  'items',
] as const;
const OPTIONAL_MANIFEST_FIELDS = [
  'lastSuccessfulFetchAt',
  'freshnessWindowId',
  'freshnessWindowIds',
] as const;
const MANIFEST_ITEM_FIELDS = ['name', 'key', 'type', 'count', 'bytes', 'sha256'] as const;

function hasManifestFields(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value);
  const allowed = new Set<string>([...MANIFEST_FIELDS, ...OPTIONAL_MANIFEST_FIELDS]);
  return (
    MANIFEST_FIELDS.every((field) => actual.includes(field)) &&
    actual.every((field) => allowed.has(field)) &&
    actual.length <= MANIFEST_FIELDS.length + OPTIONAL_MANIFEST_FIELDS.length
  );
}
const DATASET_ITEM_NAMES: Record<DataPublicationDataset, readonly string[]> = {
  'fpl:core': [
    'events',
    'teams',
    'players',
    'phases',
    'fixtures',
    'currentEventId',
    'selectionRules',
  ],
  'fpl:market': ['context'],
  'fpl:price-changes': ['context', 'players'],
};
const LEGACY_CORE_ITEM_NAMES = [
  'events',
  'teams',
  'players',
  'phases',
  'fixtures',
  'currentEventId',
];

/**
 * Full consumer reads are the integrity boundary for immutable Redis items.
 * Keep the repair hint in the publication Redis as well as locally so a read
 * in the API process can wake a reconciler running in another worker or slot.
 * The marker is scoped to one immutable publication identity and expires if a
 * process is terminated before the normal repair path can clear it.
 */
const INTEGRITY_FAILURE_TTL_SECONDS = 15 * 60;
const INTEGRITY_PROOF_TTL_SECONDS = 15 * 60;
/** Keep a healthy proof stable without turning every consumer read into a Redis command. */
const INTEGRITY_PROOF_REFRESH_THRESHOLD_SECONDS = 5 * 60;
const INTEGRITY_PROOF_REFRESH_COOLDOWN_MS = 60 * 1_000;
/** Shared marker bookkeeping must remain bounded even after an audit expires. */
const INTEGRITY_MARKER_PERSIST_TIMEOUT_MS = 1_000;
const INTEGRITY_FAILURE_SUFFIX = ':integrity-failure';
const INTEGRITY_PROOF_SUFFIX = ':integrity-proof';
/** Monotonic Redis epoch used to discard stale failure writes that race a repair. */
const INTEGRITY_REPAIR_SUFFIX = ':integrity-repair';
type IntegrityFailureMarker = Readonly<{
  token: string;
  expiresAt: number;
  observedAt: number;
  /** Caller-supplied timestamps are only used by direct diagnostics/tests. */
  observationDomain: 'redis-epoch' | 'wall-clock';
}>;
const publicationIntegrityFailures = new Map<string, IntegrityFailureMarker>();
const publicationIntegrityProofRefreshes = new Map<string, number>();
let lastIntegrityProofRefreshPruneAt = 0;

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

function hasExactItemNames(dataset: DataPublicationDataset, names: readonly string[]): boolean {
  const actual = [...names].sort();
  const expected = [...DATASET_ITEM_NAMES[dataset]].sort();
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  );
}

function hasExactNames(names: readonly string[], expectedNames: readonly string[]): boolean {
  const actual = [...names].sort();
  const expected = [...expectedNames].sort();
  return (
    actual.length === expected.length && actual.every((name, index) => name === expected[index])
  );
}

function hasAcceptedItemNames(dataset: DataPublicationDataset, names: readonly string[]): boolean {
  return (
    hasExactItemNames(dataset, names) ||
    (dataset === 'fpl:core' && hasExactNames(names, LEGACY_CORE_ITEM_NAMES))
  );
}

function isCanonicalState(
  dataset: DataPublicationDataset,
  state: unknown,
): state is DataPublicationState {
  return (
    (dataset === 'fpl:core' || dataset === 'fpl:market' || dataset === 'fpl:price-changes') &&
    state === 'active'
  );
}

const ACTIVATE_REVISION_SCRIPT = `
local candidate = cjson.decode(ARGV[1])
local current_raw = redis.call('GET', KEYS[1])
local current = nil
if current_raw then
  local decoded, value = pcall(cjson.decode, current_raw)
  if not decoded then return {'invalid_active_manifest'} end
  current = value
  if not current.items then return {'invalid_active_manifest'} end
  if current.publicationId == candidate.publicationId then
    local current_event = current.eventId == cjson.null and -1 or current.eventId
    local candidate_event = candidate.eventId == cjson.null and -1 or candidate.eventId
    if current.dataset ~= candidate.dataset
      or current.seasonCode ~= candidate.seasonCode
      or current_event ~= candidate_event
      or current.revision ~= candidate.revision
      or current.sourceCheckedAt ~= candidate.sourceCheckedAt
      or tostring(current.lastSuccessfulFetchAt) ~= tostring(candidate.lastSuccessfulFetchAt)
      or tostring(current.state) ~= tostring(candidate.state)
      or #current.items ~= #candidate.items then
      return {'publication_id_conflict'}
    end
    for index, item in ipairs(current.items) do
      local candidate_item = candidate.items[index]
      if not candidate_item
        or item.name ~= candidate_item.name
        or item.key ~= candidate_item.key
        or item.type ~= candidate_item.type
        or item.count ~= candidate_item.count
        or item.bytes ~= candidate_item.bytes
        or item.sha256 ~= candidate_item.sha256 then
        return {'publication_id_conflict'}
      end
    end
    for _, item in ipairs(candidate.items) do
      if redis.call('EXISTS', item.key) ~= 1 then
        return {'missing_stage', item.key}
      end
      local type_result = redis.call('TYPE', item.key)
      local actual_type = type(type_result) == 'table' and type_result['ok'] or type_result
      if actual_type ~= item.type then
        return {'wrong_stage_type', item.key}
      end
      if redis.call('STRLEN', item.key) ~= item.bytes then
        return {'wrong_stage_size', item.key}
      end
      redis.call('PERSIST', item.key)
    end
    return {'idempotent', current_raw}
  end
  if current.sourceCheckedAt > candidate.sourceCheckedAt then
    return {'stale', current_raw}
  end
  if current.sourceCheckedAt == candidate.sourceCheckedAt and current.revision >= candidate.revision then
    return {'stale', current_raw}
  end
end

for _, item in ipairs(candidate.items) do
  if redis.call('EXISTS', item.key) ~= 1 then
    return {'missing_stage', item.key}
  end
  local type_result = redis.call('TYPE', item.key)
  local actual_type = type(type_result) == 'table' and type_result['ok'] or type_result
  if actual_type ~= item.type then
    return {'wrong_stage_type', item.key}
  end
  if redis.call('STRLEN', item.key) ~= item.bytes then
    return {'wrong_stage_size', item.key}
  end
end

for _, item in ipairs(candidate.items) do
  redis.call('PERSIST', item.key)
end
redis.call('SET', KEYS[1], ARGV[1])

if current and current.items then
  for _, item in ipairs(current.items) do
    local retained = false
    for _, candidate_item in ipairs(candidate.items) do
      if item.key == candidate_item.key then retained = true end
    end
    if not retained and redis.call('EXISTS', item.key) == 1 then
      redis.call('PEXPIRE', item.key, ARGV[2])
    end
  end
end

return {'published', current_raw or ''}
`;

const RETIRE_ACTIVE_REVISION_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
if not current_raw then return {0, ''} end
local decoded, current = pcall(cjson.decode, current_raw)
if not decoded or not current.items then return {-1, current_raw} end
for _, item in ipairs(current.items) do
  if redis.call('EXISTS', item.key) == 1 then
    redis.call('PEXPIRE', item.key, ARGV[1])
  end
end
redis.call('DEL', KEYS[1])
return {1, current_raw}
`;

const COMPARE_AND_SWAP_ACTIVE_REVISION_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
if not current_raw then return {'missing'} end
local decoded, current = pcall(cjson.decode, current_raw)
if not decoded or not current.publicationId then return {'invalid'} end
if current.publicationId ~= ARGV[1] then return {'changed', current_raw} end
local candidate_raw = ARGV[2]
if candidate_raw == '' then
  redis.call('DEL', KEYS[1])
  return {'removed', current_raw}
end
local candidate = cjson.decode(candidate_raw)
for _, item in ipairs(candidate.items) do
  if redis.call('EXISTS', item.key) ~= 1 then return {'missing_stage', item.key} end
  redis.call('PERSIST', item.key)
end
redis.call('SET', KEYS[1], candidate_raw)
return {'replaced', current_raw}
`;

const REPAIR_ACTIVE_DATA_PUBLICATION_ITEMS_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
if not current_raw then return {'missing'} end
local decoded, current = pcall(cjson.decode, current_raw)
if not decoded or not current or not current.items then return {'invalid'} end
if current.publicationId ~= ARGV[1] then return {'changed'} end
local candidate_decoded, candidate = pcall(cjson.decode, ARGV[2])
if not candidate_decoded or not candidate or current.revision ~= candidate.revision then
  return {'conflict'}
end
if #current.items ~= #candidate.items then return {'conflict'} end
for index, item in ipairs(current.items) do
  local candidate_item = candidate.items[index]
  if not candidate_item
    or item.name ~= candidate_item.name
    or item.key ~= candidate_item.key
    or item.type ~= candidate_item.type
    or item.count ~= candidate_item.count
    or item.bytes ~= candidate_item.bytes
    or item.sha256 ~= candidate_item.sha256 then
    return {'conflict'}
  end
end
for index, item in ipairs(candidate.items) do
  local key = ARGV[6 + ((index - 1) * 2)]
  if key ~= item.key then return {'conflict'} end
end
local function valid_epoch(raw)
  if type(raw) ~= 'string' then return false end
  local digits = string.match(raw, '^%d+$')
  if not digits or (#raw > 1 and string.sub(raw, 1, 1) == '0') then return false end
  local value = tonumber(raw)
  return value ~= nil
    and value >= 0
    and value <= 9007199254740991
    and math.floor(value) == value
end
local repair_type = redis.call('TYPE', KEYS[4])
local repair_type_name = type(repair_type) == 'table' and repair_type['ok'] or repair_type
if repair_type_name == 'string' then
  local repair_raw = redis.call('GET', KEYS[4])
  if not valid_epoch(repair_raw) then
    redis.call('DEL', KEYS[4])
  elseif tonumber(repair_raw) >= 9007199254740991 then
    return {'epoch_exhausted'}
  end
elseif repair_type_name ~= 'none' and repair_type_name ~= 'string' then
  redis.call('DEL', KEYS[4])
end
local repair_epoch = redis.call('INCR', KEYS[4])
redis.call('PERSIST', KEYS[4])
for index, item in ipairs(candidate.items) do
  local key = ARGV[6 + ((index - 1) * 2)]
  local payload = ARGV[7 + ((index - 1) * 2)]
  redis.call('SET', key, payload)
  redis.call('PERSIST', key)
end
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[5])
local failure_type = redis.call('TYPE', KEYS[2])
local failure_type_name = type(failure_type) == 'table' and failure_type['ok'] or failure_type
if failure_type_name ~= 'string' then
  redis.call('DEL', KEYS[2])
elseif redis.call('GET', KEYS[2]) == ARGV[3] then
  redis.call('DEL', KEYS[2])
end
return {'repaired', tostring(repair_epoch)}
`;

const REPLACE_MALFORMED_ACTIVE_DATA_PUBLICATION_SCRIPT = `
local type_result = redis.call('TYPE', KEYS[1])
local current_type = type(type_result) == 'table' and type_result['ok'] or type_result
if current_type ~= ARGV[1] then return {'changed'} end
if current_type == 'none' then return {'missing'} end
if current_type == 'string' and redis.call('GET', KEYS[1]) ~= ARGV[2] then
  return {'changed'}
end
local candidate_decoded, candidate = pcall(cjson.decode, ARGV[3])
if not candidate_decoded or not candidate or not candidate.items then return {'conflict'} end
for index, item in ipairs(candidate.items) do
  local key = ARGV[7 + ((index - 1) * 2)]
  if key ~= item.key then return {'conflict'} end
end
local function valid_epoch(raw)
  if type(raw) ~= 'string' then return false end
  local digits = string.match(raw, '^%d+$')
  if not digits or (#raw > 1 and string.sub(raw, 1, 1) == '0') then return false end
  local value = tonumber(raw)
  return value ~= nil
    and value >= 0
    and value <= 9007199254740991
    and math.floor(value) == value
end
local repair_type = redis.call('TYPE', KEYS[4])
local repair_type_name = type(repair_type) == 'table' and repair_type['ok'] or repair_type
if repair_type_name == 'string' then
  local repair_raw = redis.call('GET', KEYS[4])
  if not valid_epoch(repair_raw) then
    redis.call('DEL', KEYS[4])
  elseif tonumber(repair_raw) >= 9007199254740991 then
    return {'epoch_exhausted'}
  end
elseif repair_type_name ~= 'none' and repair_type_name ~= 'string' then
  redis.call('DEL', KEYS[4])
end
local repair_epoch = redis.call('INCR', KEYS[4])
redis.call('PERSIST', KEYS[4])
for index, item in ipairs(candidate.items) do
  local key = ARGV[7 + ((index - 1) * 2)]
  local payload = ARGV[8 + ((index - 1) * 2)]
  redis.call('SET', key, payload)
  redis.call('PERSIST', key)
end
redis.call('SET', KEYS[1], ARGV[3])
redis.call('SET', KEYS[3], ARGV[5], 'EX', ARGV[6])
local failure_type = redis.call('TYPE', KEYS[2])
local failure_type_name = type(failure_type) == 'table' and failure_type['ok'] or failure_type
if failure_type_name ~= 'string' then
  redis.call('DEL', KEYS[2])
elseif redis.call('GET', KEYS[2]) == ARGV[4] then
  redis.call('DEL', KEYS[2])
end
return {'replaced', tostring(repair_epoch)}
`;

/**
 * Read all immutable payloads and observe the per-scope repair epoch in one
 * Redis transaction. Only a repair EVAL advances the epoch immediately before
 * it writes items, so a failure can be ordered against the payload read by the
 * Redis server rather than by caller wall-clock timestamps.
 */
const READ_DATA_PUBLICATION_PAYLOADS_WITH_EPOCH_SCRIPT = `
local function valid_epoch(raw)
  if type(raw) ~= 'string' then return false end
  local digits = string.match(raw, '^%d+$')
  if not digits or (#raw > 1 and string.sub(raw, 1, 1) == '0') then return false end
  local value = tonumber(raw)
  return value ~= nil
    and value >= 0
    and value <= 9007199254740991
    and math.floor(value) == value
end
local epoch_type = redis.call('TYPE', KEYS[1])
local epoch_type_name = type(epoch_type) == 'table' and epoch_type['ok'] or epoch_type
local epoch = 0
if epoch_type_name == 'string' then
  local raw = redis.call('GET', KEYS[1])
  if valid_epoch(raw) then
    epoch = tonumber(raw)
  else
    redis.call('DEL', KEYS[1])
  end
elseif epoch_type_name ~= 'none' then
  redis.call('DEL', KEYS[1])
end
local payloads = redis.call('MGET', unpack(ARGV, 1, #ARGV))
table.insert(payloads, 1, tostring(epoch))
return payloads
`;

/**
 * Check the failure/proof fences and capture selected immutable payloads in
 * one Redis transaction. This closes the window between a successful proof
 * lookup and a later selected read: a concurrent corruption marker is either
 * seen here or is ordered after this read and cannot invalidate its evidence.
 */
const READ_VERIFIED_DATA_PUBLICATION_PAYLOADS_SCRIPT = `
local function valid_epoch(raw)
  if type(raw) ~= 'string' then return false end
  local digits = string.match(raw, '^%d+$')
  if not digits or (#raw > 1 and string.sub(raw, 1, 1) == '0') then return false end
  local value = tonumber(raw)
  return value ~= nil
    and value >= 0
    and value <= 9007199254740991
    and math.floor(value) == value
end
local failure_type = redis.call('TYPE', KEYS[2])
local failure_type_name = type(failure_type) == 'table' and failure_type['ok'] or failure_type
if failure_type_name == 'string' then
  local failure = redis.call('GET', KEYS[2])
  if failure == '*' or failure == ARGV[1] then return {'failure'} end
elseif failure_type_name ~= 'none' then
  return {'failure'}
end
local proof_type = redis.call('TYPE', KEYS[3])
local proof_type_name = type(proof_type) == 'table' and proof_type['ok'] or proof_type
if proof_type_name ~= 'string' or redis.call('GET', KEYS[3]) ~= ARGV[2] then
  return {'proof_missing'}
end
local epoch = 0
local epoch_type = redis.call('TYPE', KEYS[1])
local epoch_type_name = type(epoch_type) == 'table' and epoch_type['ok'] or epoch_type
if epoch_type_name == 'string' then
  local raw = redis.call('GET', KEYS[1])
  if valid_epoch(raw) then
    epoch = tonumber(raw)
  else
    redis.call('DEL', KEYS[1])
  end
elseif epoch_type_name ~= 'none' then
  redis.call('DEL', KEYS[1])
end
local payloads = redis.call('MGET', unpack(ARGV, 3, #ARGV))
table.insert(payloads, 1, tostring(epoch))
table.insert(payloads, 1, 'ok')
return payloads
`;

const MARK_INTEGRITY_FAILURE_SCRIPT = `
local function valid_epoch(raw)
  if type(raw) ~= 'string' then return false end
  local digits = string.match(raw, '^%d+$')
  if not digits or (#raw > 1 and string.sub(raw, 1, 1) == '0') then return false end
  local value = tonumber(raw)
  return value ~= nil
    and value >= 0
    and value <= 9007199254740991
    and math.floor(value) == value
end
local repair_at = 0
local repair_type = redis.call('TYPE', KEYS[4])
local repair_type_name = type(repair_type) == 'table' and repair_type['ok'] or repair_type
if repair_type_name == 'string' then
  local raw = redis.call('GET', KEYS[4])
  if valid_epoch(raw) then
    repair_at = tonumber(raw)
  else
    redis.call('DEL', KEYS[4])
  end
elseif repair_type_name ~= 'none' then
  redis.call('DEL', KEYS[4])
end
local observed_at = tonumber(ARGV[3]) or 0
if observed_at < repair_at then return -1 end
local active_matches = false
if ARGV[1] ~= '*' then
  local active_raw = redis.call('GET', KEYS[3])
  if active_raw then
    local decoded, active = pcall(cjson.decode, active_raw)
    if decoded and active and active.publicationId and active.revision then
      local active_token = tostring(active.publicationId) .. ':' .. tostring(active.revision)
      if active_token ~= ARGV[1] then return 0 end
      active_matches = true
    end
  end
end
local existing_type = redis.call('TYPE', KEYS[1])
local existing_type_name = type(existing_type) == 'table' and existing_type['ok'] or existing_type
local existing = nil
if existing_type_name == 'string' then
  existing = redis.call('GET', KEYS[1])
elseif existing_type_name ~= 'none' then
  redis.call('DEL', KEYS[1])
end
if existing and existing ~= ARGV[1] and not active_matches then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('DEL', KEYS[2])
return 1
`;

const MARK_INTEGRITY_PROOF_SCRIPT = `
local marker_type = redis.call('TYPE', KEYS[1])
local marker_type_name = type(marker_type) == 'table' and marker_type['ok'] or marker_type
local current = nil
local ttl = -1
if marker_type_name == 'string' then
  current = redis.call('GET', KEYS[1])
  ttl = redis.call('PTTL', KEYS[1])
end
if current == ARGV[1] and ttl > tonumber(ARGV[3]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

const CLEAR_INTEGRITY_FAILURE_SCRIPT = `
local marker_type = redis.call('TYPE', KEYS[1])
local marker_type_name = type(marker_type) == 'table' and marker_type['ok'] or marker_type
if marker_type_name ~= 'string' then
  redis.call('DEL', KEYS[1])
elseif redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
end
return 1
`;

function assertScope(scope: DataPublicationScope): void {
  if (!/^\d{4}$/.test(scope.seasonCode)) {
    throw new CacheError('Invalid publication season', 'DATA_PUBLICATION_SEASON_INVALID');
  }
  if (scope.eventId !== undefined) {
    throw new CacheError(
      'A generic publication cannot have an event ID',
      'DATA_PUBLICATION_EVENT_INVALID',
    );
  }
}

function scopePrefix(scope: DataPublicationScope): string {
  assertScope(scope);
  return `${DATA_CACHE_NAMESPACE}:${scope.dataset}:${scope.seasonCode}`;
}

function integrityFailureKey(scope: DataPublicationScope): string {
  return `${scopePrefix(scope)}${INTEGRITY_FAILURE_SUFFIX}`;
}

function integrityProofKey(scope: DataPublicationScope): string {
  return `${scopePrefix(scope)}${INTEGRITY_PROOF_SUFFIX}`;
}

function integrityRepairKey(scope: DataPublicationScope): string {
  return `${scopePrefix(scope)}${INTEGRITY_REPAIR_SUFFIX}`;
}

/** Internal Redis key used by tests and control-path diagnostics. */
export function dataPublicationIntegrityProofKey(scope: DataPublicationScope): string {
  return integrityProofKey(scope);
}

function publicationIntegrityToken(manifest: DataPublicationManifest): string {
  return `${manifest.publicationId}:${manifest.revision}`;
}

function publicationIntegrityProofToken(manifest: DataPublicationManifest): string {
  return `${publicationIntegrityToken(manifest)}:${sha256(canonicalJson(manifest))}`;
}

/** Internal proof token used by focused contract tests and control diagnostics. */
export function dataPublicationIntegrityProofToken(manifest: DataPublicationManifest): string {
  return publicationIntegrityProofToken(manifest);
}

function publicationManifestsMatch(
  left: DataPublicationManifest,
  right: DataPublicationManifest,
): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function localIntegrityFailureKey(prefix: string, token: string): string {
  return `${prefix}:${token}`;
}

function localIntegrityFailureEntries(prefix: string): Array<[string, IntegrityFailureMarker]> {
  const markerPrefix = `${prefix}:`;
  return [...publicationIntegrityFailures.entries()].filter(([key]) =>
    key.startsWith(markerPrefix),
  );
}

function clearLocalIntegrityFailureAfterRepair(
  scope: DataPublicationScope,
  manifest: DataPublicationManifest,
  repairEpoch: number,
): void {
  const prefix = scopePrefix(scope);
  const expected = publicationIntegrityToken(manifest);
  const exactKey = localIntegrityFailureKey(prefix, expected);
  const exact = publicationIntegrityFailures.get(exactKey);
  if (exact && (exact.observationDomain === 'wall-clock' || exact.observedAt < repairEpoch)) {
    publicationIntegrityFailures.delete(exactKey);
  }
  // A full read records the Redis epoch at which it atomically captured the
  // immutable payload. A read ordered before this repair is stale evidence and
  // may be cleared; a read at or after this repair stays sticky for a new repair.
}

async function getRedisForIntegrityMarker(
  redisClient?: Redis,
  deadlineAt?: number,
): Promise<Redis> {
  if (redisClient) return redisClient;
  if (deadlineAt === undefined) return redisSingleton.getClient();
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('Publication audit deadline exceeded');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Publication audit deadline exceeded')),
        remainingMs,
      );
    });
    return await Promise.race([redisSingleton.getClient(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function markDataPublicationIntegrityFailure(
  scope: DataPublicationScope,
  manifest?: DataPublicationManifest,
  redisClient?: Redis,
  deadlineAt?: number,
  observedAt?: number,
): Promise<void> {
  const prefix = scopePrefix(scope);
  const token = manifest ? publicationIntegrityToken(manifest) : '*';
  const now = Date.now();
  const observedValue = observedAt ?? now;
  const observationDomain = observedAt === undefined ? 'wall-clock' : 'redis-epoch';
  const localKey = localIntegrityFailureKey(prefix, token);
  publicationIntegrityFailures.set(localKey, {
    token,
    expiresAt: now + INTEGRITY_FAILURE_TTL_SECONDS * 1_000,
    observedAt: observedValue,
    observationDomain,
  });
  const persist = async (): Promise<void> => {
    try {
      const redis = await getRedisForIntegrityMarker(redisClient);
      let outcome: number;
      if (deadlineAt === undefined) {
        outcome = Number(
          await redis.eval(
            MARK_INTEGRITY_FAILURE_SCRIPT,
            4,
            integrityFailureKey(scope),
            integrityProofKey(scope),
            activeDataPublicationKey(scope),
            integrityRepairKey(scope),
            token,
            String(INTEGRITY_FAILURE_TTL_SECONDS),
            String(observedValue),
          ),
        );
      } else {
        // The request deadline may already be exhausted when corruption is
        // detected. Keep shared evidence durable with its own short bound while
        // leaving the audit response path completely asynchronous.
        const markerDeadlineAt = Date.now() + INTEGRITY_MARKER_PERSIST_TIMEOUT_MS;
        outcome = Number(
          await redisCommandWithDeadline<number>(
            redis,
            'eval',
            [
              MARK_INTEGRITY_FAILURE_SCRIPT,
              '4',
              integrityFailureKey(scope),
              integrityProofKey(scope),
              activeDataPublicationKey(scope),
              integrityRepairKey(scope),
              token,
              String(INTEGRITY_FAILURE_TTL_SECONDS),
              String(observedValue),
            ],
            markerDeadlineAt,
          ),
        );
      }
      // MARK_INTEGRITY_FAILURE_SCRIPT returns -1 only when the payload read
      // was ordered before a repair. Do not clear a marker for an active-pointer
      // conflict (return 0), which may be fresh evidence for another identity.
      if (outcome === -1) {
        const current = publicationIntegrityFailures.get(localKey);
        if (
          current &&
          current.observationDomain === observationDomain &&
          current.observedAt <= observedValue
        ) {
          publicationIntegrityFailures.delete(localKey);
        }
      }
    } catch {
      // The local marker still protects this process when the shared marker
      // cannot be written during the same Redis incident.
    }
  };
  if (deadlineAt !== undefined) {
    // An explicit audit has a hard wall-clock budget. Local evidence is enough
    // for this request; shared bookkeeping must not consume the remaining
    // budget or turn a detected corruption into a hung audit.
    void persist();
    return;
  }
  await persist();
}

export async function hasDataPublicationIntegrityFailure(
  scope: DataPublicationScope,
  manifest?: DataPublicationManifest | null,
  redisClient?: Redis,
  deadlineAt?: number,
): Promise<boolean> {
  const prefix = scopePrefix(scope);
  const expected = manifest ? publicationIntegrityToken(manifest) : null;
  const localEntries = localIntegrityFailureEntries(prefix);
  for (const [key, marker] of localEntries) {
    if (marker.expiresAt <= Date.now()) publicationIntegrityFailures.delete(key);
  }
  const localCandidates = expected
    ? [
        publicationIntegrityFailures.get(localIntegrityFailureKey(prefix, '*')),
        publicationIntegrityFailures.get(localIntegrityFailureKey(prefix, expected)),
      ]
    : localIntegrityFailureEntries(prefix).map(([, marker]) => marker);
  const localMatches = localCandidates.some(
    (marker) => marker !== undefined && marker.expiresAt > Date.now(),
  );
  try {
    const redis = await getRedisForIntegrityMarker(redisClient, deadlineAt);
    const shared =
      deadlineAt === undefined
        ? await redis.get(integrityFailureKey(scope))
        : await redisCommandWithDeadline<string | null>(
            redis,
            'get',
            [integrityFailureKey(scope)],
            deadlineAt,
          );
    if (shared && (!expected || shared === '*' || shared === expected)) return true;
    // A matching local marker is already sufficient evidence for this process.
    // Do not perform a second proof lookup that cannot change the result; during
    // a Redis incident that redundant command would only add latency to every
    // control-path caller until the local marker expires.
    return localMatches;
  } catch {
    // Redis is the cross-process source of integrity evidence. If its marker
    // cannot be read, absence of a local marker is not proof that another
    // process has not recorded corruption; fail closed until the marker path
    // is readable again.
    return true;
  }
}

export async function clearDataPublicationIntegrityFailure(
  scope: DataPublicationScope,
  redisClient?: Redis,
  manifest?: DataPublicationManifest,
): Promise<void> {
  const prefix = scopePrefix(scope);
  if (!manifest) {
    for (const [key] of localIntegrityFailureEntries(prefix)) {
      publicationIntegrityFailures.delete(key);
    }
  } else {
    publicationIntegrityFailures.delete(
      localIntegrityFailureKey(prefix, publicationIntegrityToken(manifest)),
    );
  }
  try {
    const redis = await getRedisForIntegrityMarker(redisClient);
    if (!manifest) {
      await redis.del(integrityFailureKey(scope));
      return;
    }
    await redis.eval(
      CLEAR_INTEGRITY_FAILURE_SCRIPT,
      1,
      integrityFailureKey(scope),
      publicationIntegrityToken(manifest),
    );
  } catch {
    // A failed cleanup is harmless; the shared marker is TTL bounded and a
    // subsequent full proof can clear it when Redis is healthy again.
  }
}

export async function markDataPublicationIntegrityProof(
  manifest: DataPublicationManifest,
  redisClient?: Redis,
  options: { readonly fireAndForget?: boolean } = {},
): Promise<void> {
  const scope = {
    dataset: manifest.dataset,
    seasonCode: manifest.seasonCode,
  } as DataPublicationScope;
  const prefix = scopePrefix(scope);
  const token = publicationIntegrityProofToken(manifest);
  const refreshKey = localIntegrityFailureKey(prefix, token);
  const now = Date.now();
  if (now - lastIntegrityProofRefreshPruneAt >= INTEGRITY_PROOF_REFRESH_COOLDOWN_MS) {
    lastIntegrityProofRefreshPruneAt = now;
    for (const [key, expiresAt] of publicationIntegrityProofRefreshes) {
      if (expiresAt <= now) publicationIntegrityProofRefreshes.delete(key);
    }
  }
  if (options.fireAndForget && (publicationIntegrityProofRefreshes.get(refreshKey) ?? 0) > now) {
    return;
  }
  if (options.fireAndForget) {
    publicationIntegrityProofRefreshes.set(refreshKey, now + INTEGRITY_PROOF_REFRESH_COOLDOWN_MS);
  }
  // Never clear a non-expired local failure here. A concurrent reader may have
  // recorded corruption for this same revision after this read completed, and
  // only the atomic repair path may remove that evidence.
  for (const [key, local] of localIntegrityFailureEntries(prefix)) {
    if (local.expiresAt <= Date.now()) publicationIntegrityFailures.delete(key);
  }
  const persist = async (): Promise<void> => {
    try {
      const redis = await getRedisForIntegrityMarker(redisClient);
      await redis.eval(
        MARK_INTEGRITY_PROOF_SCRIPT,
        1,
        integrityProofKey(scope),
        token,
        String(INTEGRITY_PROOF_TTL_SECONDS),
        String(INTEGRITY_PROOF_REFRESH_THRESHOLD_SECONDS * 1_000),
      );
    } catch {
      // A proof marker is an optimization. The next selected read will perform
      // one complete validation if it cannot observe this marker.
    }
  };
  if (options.fireAndForget) {
    void persist();
    return;
  }
  await persist();
}

export async function hasDataPublicationIntegrityProof(
  scope: DataPublicationScope,
  manifest: DataPublicationManifest,
  redisClient?: Redis,
): Promise<boolean> {
  try {
    const redis = await getRedisForIntegrityMarker(redisClient);
    return (await redis.get(integrityProofKey(scope))) === publicationIntegrityProofToken(manifest);
  } catch {
    return false;
  }
}

/**
 * Run one Redis command with the audit's remaining deadline. ioredis applies
 * the shared five-second command timeout when a command has no timer; setting
 * the timer before sending this command gives an explicit audit read the
 * smaller remaining budget without racing and abandoning a live promise.
 */
async function redisCommandWithDeadline<T>(
  redis: Redis,
  name: string,
  args: readonly string[],
  deadlineAt?: number,
): Promise<T> {
  if (deadlineAt === undefined) {
    return (await redis.call(name, ...args)) as T;
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error('Publication audit deadline exceeded');
  const command = new RedisCommand(name, [...args], { replyEncoding: 'utf8' });
  command.setTimeout(remainingMs);
  return (await redis.sendCommand(command)) as T;
}

type DataPublicationPayloadsWithEpoch = Readonly<{
  observedEpoch: number;
  payloads: Array<string | null>;
}>;

/**
 * Capture the ordering epoch and payloads in one Redis EVAL. The fallback is
 * only for the small in-memory Redis fakes used by unit tests; ioredis always
 * exposes EVAL in production.
 */
async function readDataPublicationPayloadsWithEpoch(
  scope: DataPublicationScope,
  keys: readonly string[],
  redis: Redis,
  deadlineAt?: number,
): Promise<DataPublicationPayloadsWithEpoch> {
  if (keys.length === 0) throw new Error('Publication payload keys are required');
  const evalMethod = (redis as unknown as { eval?: (...args: unknown[]) => Promise<unknown> }).eval;
  const mgetMethod = (
    redis as unknown as {
      mget?: (...args: string[]) => Promise<Array<string | null>>;
    }
  ).mget;
  const raw =
    typeof evalMethod === 'function'
      ? deadlineAt === undefined
        ? await evalMethod.call(
            redis,
            READ_DATA_PUBLICATION_PAYLOADS_WITH_EPOCH_SCRIPT,
            1,
            integrityRepairKey(scope),
            ...keys,
          )
        : await redisCommandWithDeadline<unknown>(
            redis,
            'eval',
            [
              READ_DATA_PUBLICATION_PAYLOADS_WITH_EPOCH_SCRIPT,
              '1',
              integrityRepairKey(scope),
              ...keys,
            ],
            deadlineAt,
          )
      : typeof mgetMethod === 'function'
        ? await mgetMethod.call(redis, ...keys)
        : await Promise.all(keys.map((key) => redis.get(key)));
  if (typeof evalMethod !== 'function') {
    return { observedEpoch: Date.now(), payloads: raw as Array<string | null> };
  }
  if (!Array.isArray(raw) || raw.length !== keys.length + 1) {
    throw new Error('Publication payload epoch read returned an invalid result');
  }
  const observedEpoch = Number(raw[0]);
  if (!Number.isSafeInteger(observedEpoch) || observedEpoch < 0) {
    throw new Error('Publication payload epoch is invalid');
  }
  const payloads = raw.slice(1).map((payload) => (payload === false ? null : payload));
  if (payloads.some((payload) => payload !== null && typeof payload !== 'string')) {
    throw new Error('Publication payload epoch read returned a non-string payload');
  }
  return { observedEpoch, payloads: payloads as Array<string | null> };
}

type VerifiedDataPublicationPayloads =
  | Readonly<{ status: 'ok'; observedEpoch: number; payloads: Array<string | null> }>
  | Readonly<{ status: 'failure' | 'proof_missing' }>;

/**
 * Check the integrity fences and read selected payloads in one Redis EVAL.
 * Production uses ioredis EVAL; the command-by-command branch exists only for
 * the in-memory Redis fakes used by unit tests.
 */
async function readVerifiedDataPublicationPayloads(
  scope: DataPublicationScope,
  manifest: DataPublicationManifest,
  keys: readonly string[],
  redis: Redis,
): Promise<VerifiedDataPublicationPayloads> {
  if (keys.length === 0) throw new Error('Publication payload keys are required');
  const evalMethod = (redis as unknown as { eval?: (...args: unknown[]) => Promise<unknown> }).eval;
  if (typeof evalMethod !== 'function') {
    if (await hasDataPublicationIntegrityFailure(scope, manifest, redis)) {
      return { status: 'failure' };
    }
    if (!(await hasDataPublicationIntegrityProof(scope, manifest, redis))) {
      return { status: 'proof_missing' };
    }
    const mgetMethod = (
      redis as unknown as {
        mget?: (...args: string[]) => Promise<Array<string | null>>;
      }
    ).mget;
    const payloads =
      typeof mgetMethod === 'function'
        ? await mgetMethod.call(redis, ...keys)
        : await Promise.all(keys.map((key) => redis.get(key)));
    return { status: 'ok', observedEpoch: Date.now(), payloads };
  }
  const raw = await evalMethod.call(
    redis,
    READ_VERIFIED_DATA_PUBLICATION_PAYLOADS_SCRIPT,
    3,
    integrityRepairKey(scope),
    integrityFailureKey(scope),
    integrityProofKey(scope),
    publicationIntegrityToken(manifest),
    publicationIntegrityProofToken(manifest),
    ...keys,
  );
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Verified publication payload read returned an invalid result');
  }
  const status = raw[0];
  if (status === 'failure' || status === 'proof_missing') return { status };
  if (status !== 'ok' || raw.length !== keys.length + 2) {
    throw new Error('Verified publication payload read returned an invalid result');
  }
  const observedEpoch = Number(raw[1]);
  if (!Number.isSafeInteger(observedEpoch) || observedEpoch < 0) {
    throw new Error('Verified publication payload epoch is invalid');
  }
  const payloads = raw.slice(2).map((payload) => (payload === false ? null : payload));
  if (payloads.some((payload) => payload !== null && typeof payload !== 'string')) {
    throw new Error('Verified publication payload read returned a non-string payload');
  }
  return { status: 'ok', observedEpoch, payloads: payloads as Array<string | null> };
}

export function activeDataPublicationKey(scope: DataPublicationScope): string {
  return `${scopePrefix(scope)}:active`;
}

export type ActiveDataPublicationPointerState = Readonly<{
  type: string;
  raw: string | null;
}>;

/** Read the exact active-key state without decoding or fetching item payloads. */
export async function readActiveDataPublicationPointerState(
  scope: DataPublicationScope,
  redisClient?: Redis,
): Promise<ActiveDataPublicationPointerState> {
  assertScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  const type = await redis.type(activeDataPublicationKey(scope));
  if (type === 'none') return { type, raw: null };
  if (type === 'string') {
    return { type, raw: await redis.get(activeDataPublicationKey(scope)) };
  }
  return { type, raw: null };
}

export function dataPublicationItemKey(
  scope: DataPublicationScope,
  revision: number,
  itemName: string,
): string {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new CacheError('Invalid publication revision', 'DATA_PUBLICATION_REVISION_INVALID');
  }
  if (!/^[a-z][a-zA-Z0-9]*$/.test(itemName)) {
    throw new CacheError(
      `Invalid publication item name: ${itemName}`,
      'DATA_PUBLICATION_ITEM_NAME_INVALID',
    );
  }
  return `${scopePrefix(scope)}:${revision}:${itemName}`;
}

function itemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return value === null || value === undefined ? 0 : 1;
}

function sha256(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function serializeItems(input: PublishDataRevisionInput): SerializedItem[] {
  if (input.items.length === 0) {
    throw new CacheError(
      'A publication requires at least one item',
      'DATA_PUBLICATION_ITEMS_EMPTY',
    );
  }
  const names = new Set<string>();
  const serialized: SerializedItem[] = input.items.map((item) => {
    if (names.has(item.name)) {
      throw new CacheError(
        `Duplicate publication item: ${item.name}`,
        'DATA_PUBLICATION_ITEM_DUPLICATE',
      );
    }
    names.add(item.name);
    let payload: string;
    try {
      payload = canonicalJson(item.value);
    } catch {
      throw new CacheError(
        `Publication item ${item.name} is not JSON serializable`,
        'DATA_PUBLICATION_ITEM_INVALID',
      );
    }
    return {
      payload,
      manifest: {
        name: item.name,
        key: dataPublicationItemKey(input, input.revision, item.name),
        type: 'string' as const,
        count: itemCount(item.value),
        bytes: Buffer.byteLength(payload, 'utf8'),
        sha256: sha256(payload),
      },
    };
  });
  if (!hasExactItemNames(input.dataset, [...names])) {
    throw new CacheError(
      `Publication item set does not match ${input.dataset}`,
      'DATA_PUBLICATION_ITEM_SET_INVALID',
    );
  }
  return serialized;
}

function createManifest(
  input: PublishDataRevisionInput,
  items: readonly SerializedItem[],
): DataPublicationManifest {
  if (!Number.isFinite(input.sourceCheckedAt.getTime())) {
    throw new CacheError(
      'Invalid publication source timestamp',
      'DATA_PUBLICATION_SOURCE_TIME_INVALID',
    );
  }
  if (input.lastSuccessfulFetchAt && !Number.isFinite(input.lastSuccessfulFetchAt.getTime())) {
    throw new CacheError(
      'Invalid publication successful-fetch timestamp',
      'DATA_PUBLICATION_SUCCESSFUL_FETCH_TIME_INVALID',
    );
  }
  const sourceCheckedAt = input.sourceCheckedAt.toISOString();
  const lastSuccessfulFetchAt = input.lastSuccessfulFetchAt?.toISOString();
  if (
    input.freshnessWindowId !== undefined &&
    (!Number.isSafeInteger(input.freshnessWindowId) || input.freshnessWindowId <= 0)
  ) {
    throw new CacheError(
      'Invalid freshness window ID',
      'DATA_PUBLICATION_FRESHNESS_WINDOW_INVALID',
    );
  }
  const freshnessWindowIds = input.freshnessWindowIds
    ? [...new Set(input.freshnessWindowIds)]
    : undefined;
  if (freshnessWindowIds?.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new CacheError(
      'Invalid freshness window IDs',
      'DATA_PUBLICATION_FRESHNESS_WINDOWS_INVALID',
    );
  }
  if (!isDataPublicationId(input.publicationId)) {
    throw new CacheError('Invalid publication ID', 'DATA_PUBLICATION_ID_INVALID');
  }
  if (!isCanonicalState(input.dataset, input.state)) {
    throw new CacheError('Invalid publication state', 'DATA_PUBLICATION_STATE_INVALID');
  }
  return {
    dataset: input.dataset,
    seasonCode: input.seasonCode,
    eventId: input.eventId ?? null,
    revision: input.revision,
    publicationId: input.publicationId,
    sourceCheckedAt,
    ...(lastSuccessfulFetchAt ? { lastSuccessfulFetchAt } : {}),
    ...(input.freshnessWindowId === undefined
      ? {}
      : { freshnessWindowId: input.freshnessWindowId }),
    ...(freshnessWindowIds === undefined || freshnessWindowIds.length === 0
      ? {}
      : { freshnessWindowIds }),
    publishedAt: (input.publishedAt ?? new Date()).toISOString(),
    state: input.state,
    items: items.map((item) => item.manifest),
  };
}

/**
 * Build the immutable publication proof without touching Redis.  Callers that
 * persist canonical facts in PostgreSQL can store this manifest and dispatch
 * it after commit, which guarantees Redis never leads an uncommitted DB row.
 */
export function prepareDataPublication(input: PublishDataRevisionInput): {
  readonly manifest: DataPublicationManifest;
  readonly items: readonly DataPublicationDeliveryItem[];
} {
  assertScope(input);
  const items = serializeItems(input);
  return { manifest: createManifest(input, items), items };
}

async function stageDataPublicationItems(
  manifest: DataPublicationManifest,
  items: readonly DataPublicationDeliveryItem[],
  redis: Redis,
): Promise<void> {
  const stage = redis.pipeline();
  for (const item of items) {
    stage.set(item.manifest.key, item.payload, 'PX', DATA_PUBLICATION_STAGING_TTL_MS, 'NX');
  }
  const stageResults = await stage.exec();
  if (!stageResults) {
    throw new CacheError('Publication staging returned no result', 'DATA_PUBLICATION_STAGE_FAILED');
  }
  const stageError = stageResults.find(([error]) => error)?.[0];
  if (stageError) throw stageError;

  const stagedPayloads = await redis.mget(...items.map((item) => item.manifest.key));
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (stagedPayloads[index] !== item.payload) {
      throw new CacheError(
        `Publication stage conflicts with immutable item ${item.manifest.name}`,
        'DATA_PUBLICATION_STAGE_CONFLICT',
      );
    }
  }

  if (
    !hasAcceptedItemNames(
      manifest.dataset,
      items.map((item) => item.manifest.name),
    )
  ) {
    throw new CacheError(
      `Publication item set does not match ${manifest.dataset}`,
      'DATA_PUBLICATION_ITEM_SET_INVALID',
    );
  }
}

export async function stageDataPublication(
  prepared: {
    readonly manifest: DataPublicationManifest;
    readonly items: readonly DataPublicationDeliveryItem[];
  },
  redisClient?: Redis,
): Promise<void> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  await stageDataPublicationItems(prepared.manifest, prepared.items, redis);
}

/**
 * Replace only the immutable items for an already identified publication.
 * Reconciliation uses this after the active pointer proves that the keys
 * belong to the same publication; ordinary producers must continue to use
 * the NX staging path above.
 */
export async function repairDataPublicationItems(
  prepared: {
    readonly manifest: DataPublicationManifest;
    readonly items: readonly DataPublicationDeliveryItem[];
  },
  expectedPublicationId: string,
  redisClient?: Redis,
): Promise<void> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  if (prepared.manifest.publicationId !== expectedPublicationId) {
    throw new CacheError(
      'Repair publication identity does not match the active pointer',
      'DATA_PUBLICATION_REPAIR_CONFLICT',
    );
  }
  const itemArgs = prepared.items.flatMap((item) => [item.manifest.key, item.payload]);
  const args = [
    expectedPublicationId,
    JSON.stringify(prepared.manifest),
    publicationIntegrityToken(prepared.manifest),
    publicationIntegrityProofToken(prepared.manifest),
    String(INTEGRITY_PROOF_TTL_SECONDS),
    ...itemArgs,
  ];
  const scope = {
    dataset: prepared.manifest.dataset,
    seasonCode: prepared.manifest.seasonCode,
  } as DataPublicationScope;
  const result = (await redis.eval(
    REPAIR_ACTIVE_DATA_PUBLICATION_ITEMS_SCRIPT,
    4,
    activeDataPublicationKey(scope),
    integrityFailureKey(scope),
    integrityProofKey(scope),
    integrityRepairKey(scope),
    ...args,
  )) as [string, string?];
  if (result[0] !== 'repaired') {
    throw new CacheError(
      `Atomic publication item repair failed: ${result[0] ?? 'unknown'}`,
      'DATA_PUBLICATION_REPAIR_CONFLICT',
    );
  }
  const repairEpoch = Number(result[1]);
  if (!Number.isSafeInteger(repairEpoch) || repairEpoch <= 0) {
    throw new CacheError(
      'Atomic publication item repair returned an invalid epoch',
      'DATA_PUBLICATION_REPAIR_CONFLICT',
    );
  }
  clearLocalIntegrityFailureAfterRepair(scope, prepared.manifest, repairEpoch);
}

/** Replace a malformed Data-owned active pointer and its canonical items atomically. */
export async function replaceMalformedActiveDataPublication(
  prepared: {
    readonly manifest: DataPublicationManifest;
    readonly items: readonly DataPublicationDeliveryItem[];
  },
  observed: ActiveDataPublicationPointerState,
  redisClient?: Redis,
): Promise<void> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  if (observed.type === 'none') {
    throw new CacheError(
      'Malformed publication replacement requires an observed active key',
      'DATA_PUBLICATION_REPAIR_CONFLICT',
    );
  }
  const itemArgs = prepared.items.flatMap((item) => [item.manifest.key, item.payload]);
  const args = [
    observed.type,
    observed.raw ?? '',
    JSON.stringify(prepared.manifest),
    publicationIntegrityToken(prepared.manifest),
    publicationIntegrityProofToken(prepared.manifest),
    String(INTEGRITY_PROOF_TTL_SECONDS),
    ...itemArgs,
  ];
  const scope = {
    dataset: prepared.manifest.dataset,
    seasonCode: prepared.manifest.seasonCode,
  } as DataPublicationScope;
  const result = (await redis.eval(
    REPLACE_MALFORMED_ACTIVE_DATA_PUBLICATION_SCRIPT,
    4,
    activeDataPublicationKey(scope),
    integrityFailureKey(scope),
    integrityProofKey(scope),
    integrityRepairKey(scope),
    ...args,
  )) as [string, string?];
  if (result[0] !== 'replaced') {
    throw new CacheError(
      `Malformed publication replacement failed: ${result[0] ?? 'unknown'}`,
      'DATA_PUBLICATION_REPAIR_CONFLICT',
    );
  }
  const repairEpoch = Number(result[1]);
  if (!Number.isSafeInteger(repairEpoch) || repairEpoch <= 0) {
    throw new CacheError(
      'Malformed publication replacement returned an invalid epoch',
      'DATA_PUBLICATION_REPAIR_CONFLICT',
    );
  }
  clearLocalIntegrityFailureAfterRepair(scope, prepared.manifest, repairEpoch);
}

export async function activateDataPublicationPointer(
  manifest: DataPublicationManifest,
  redisClient?: Redis,
): Promise<PublishDataRevisionResult> {
  const redis = redisClient ?? (await redisSingleton.getClient());
  const rawResult = (await redis.eval(
    ACTIVATE_REVISION_SCRIPT,
    1,
    activeDataPublicationKey({
      dataset: manifest.dataset,
      seasonCode: manifest.seasonCode,
      ...(manifest.eventId === null ? {} : { eventId: manifest.eventId }),
    }),
    JSON.stringify(manifest),
    String(DATA_PUBLICATION_RETIRED_TTL_MS),
  )) as [string, string?];
  const [status, detail = ''] = rawResult;
  if (status === 'idempotent') {
    const activeManifest = parseDataPublicationManifest(detail);
    if (!activeManifest) {
      throw new CacheError(
        'Idempotent publication returned an invalid active manifest',
        'DATA_PUBLICATION_ACTIVATION_FAILED',
      );
    }
    // The Lua activation already committed the immutable pointer. Proof
    // bookkeeping is best-effort and must not delay or turn a successful
    // idempotent delivery into a retry when Redis is reconnecting.
    void markDataPublicationIntegrityProof(activeManifest, redis, { fireAndForget: true });
    return { status: 'published', manifest: activeManifest, previousManifest: null };
  }
  if (status === 'stale') {
    return {
      status: 'stale',
      manifest,
      previousManifest: parseDataPublicationManifest(detail),
    };
  }
  if (status !== 'published') {
    throw new CacheError(
      `Atomic publication failed: ${status}${detail ? ` (${detail})` : ''}`,
      'DATA_PUBLICATION_ACTIVATION_FAILED',
    );
  }
  // The Lua activation already committed the immutable pointer. Proof
  // bookkeeping is best-effort and must not delay or turn a successful
  // delivery into a retry when Redis is reconnecting.
  void markDataPublicationIntegrityProof(manifest, redis, { fireAndForget: true });
  return {
    status: 'published',
    manifest,
    previousManifest: parseDataPublicationManifest(detail),
  };
}

/** Replace a cache pointer only when it still names the expected publication. */
export async function compareAndSwapDataPublicationPointer(
  scope: DataPublicationScope,
  expectedPublicationId: string,
  replacement: DataPublicationManifest | null,
  redisClient?: Redis,
): Promise<'replaced' | 'removed' | 'missing' | 'changed'> {
  assertScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  const result = (await redis.eval(
    COMPARE_AND_SWAP_ACTIVE_REVISION_SCRIPT,
    1,
    activeDataPublicationKey(scope),
    expectedPublicationId,
    replacement ? JSON.stringify(replacement) : '',
  )) as [string, string?];
  const status = result[0];
  if (
    status === 'replaced' ||
    status === 'removed' ||
    status === 'missing' ||
    status === 'changed'
  ) {
    return status;
  }
  throw new CacheError(
    `Compare-and-swap publication failed: ${status}`,
    'DATA_PUBLICATION_CAS_FAILED',
  );
}

export function parseDataPublicationManifest(raw: string | null): DataPublicationManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !hasManifestFields(value)) return null;
    if (
      value.dataset !== 'fpl:core' &&
      value.dataset !== 'fpl:market' &&
      value.dataset !== 'fpl:price-changes'
    )
      return null;
    const dataset = value.dataset;
    if (
      typeof value.seasonCode !== 'string' ||
      !/^\d{4}$/.test(value.seasonCode) ||
      typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision <= 0 ||
      !isDataPublicationId(value.publicationId) ||
      typeof value.sourceCheckedAt !== 'string' ||
      !Number.isFinite(new Date(value.sourceCheckedAt).getTime()) ||
      (value.lastSuccessfulFetchAt !== undefined &&
        (typeof value.lastSuccessfulFetchAt !== 'string' ||
          !Number.isFinite(new Date(value.lastSuccessfulFetchAt).getTime()))) ||
      (value.freshnessWindowId !== undefined &&
        (typeof value.freshnessWindowId !== 'number' ||
          !Number.isSafeInteger(value.freshnessWindowId) ||
          value.freshnessWindowId <= 0)) ||
      (value.freshnessWindowIds !== undefined &&
        (!Array.isArray(value.freshnessWindowIds) ||
          value.freshnessWindowIds.some(
            (windowId) =>
              typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId <= 0,
          ))) ||
      typeof value.publishedAt !== 'string' ||
      !Number.isFinite(new Date(value.publishedAt).getTime()) ||
      !isCanonicalState(dataset, value.state) ||
      !Array.isArray(value.items)
    ) {
      return null;
    }
    if (value.eventId !== null) {
      return null;
    }
    const scope: DataPublicationScope = {
      dataset,
      seasonCode: value.seasonCode,
    };
    assertScope(scope);
    const revision = value.revision as number;
    const names = new Set<string>();
    for (const item of value.items) {
      if (
        !isRecord(item) ||
        !hasExactFields(item, MANIFEST_ITEM_FIELDS) ||
        typeof item.name !== 'string' ||
        !/^[a-z][a-zA-Z0-9]*$/.test(item.name) ||
        names.has(item.name) ||
        item.type !== 'string' ||
        typeof item.key !== 'string' ||
        item.key !== dataPublicationItemKey(scope, revision, item.name) ||
        typeof item.count !== 'number' ||
        !Number.isInteger(item.count) ||
        item.count < 0 ||
        typeof item.bytes !== 'number' ||
        !Number.isInteger(item.bytes) ||
        item.bytes < 0 ||
        typeof item.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(item.sha256)
      ) {
        return null;
      }
      names.add(item.name);
    }
    if (!hasAcceptedItemNames(dataset, [...names])) return null;
    return value as unknown as DataPublicationManifest;
  } catch {
    return null;
  }
}

function assertManifestMatchesScope(
  manifest: DataPublicationManifest,
  scope: DataPublicationScope,
): boolean {
  return (
    manifest.dataset === scope.dataset &&
    manifest.seasonCode === scope.seasonCode &&
    manifest.eventId === (scope.eventId ?? null)
  );
}

export async function publishDataRevision(
  input: PublishDataRevisionInput,
  options: PublishDataRevisionOptions = {},
): Promise<PublishDataRevisionResult> {
  const redis = options.redis ?? (await redisSingleton.getClient());
  const prepared = prepareDataPublication(input);
  const { manifest } = prepared;
  await stageDataPublicationItems(manifest, prepared.items, redis);
  await options.afterStage?.(manifest);

  const accepted = (await options.beforeActivate?.()) !== false;
  if (!accepted) {
    return { status: 'stale', manifest, previousManifest: null };
  }
  if (options.activate === false) {
    return { status: 'published', manifest, previousManifest: null };
  }
  const result = await activateDataPublicationPointer(manifest, redis);
  if (result.status === 'published' && !assertManifestMatchesScope(result.manifest, input)) {
    throw new CacheError(
      'Idempotent publication returned a manifest for another scope',
      'DATA_PUBLICATION_ACTIVATION_FAILED',
    );
  }
  return result;
}

export async function readActiveDataPublication(
  scope: DataPublicationScope,
  redisClient?: Redis,
  deadlineAt?: number,
  expectedManifest?: DataPublicationManifest,
): Promise<DataPublicationReadResult | null> {
  assertScope(scope);
  const deadlineExceeded = (): boolean => deadlineAt !== undefined && Date.now() >= deadlineAt;
  try {
    const redis = await getRedisForIntegrityMarker(redisClient, deadlineAt);
    const manifest = parseDataPublicationManifest(
      deadlineAt === undefined
        ? await redis.get(activeDataPublicationKey(scope))
        : await redisCommandWithDeadline<string | null>(
            redis,
            'get',
            [activeDataPublicationKey(scope)],
            deadlineAt,
          ),
    );
    if (!manifest || !assertManifestMatchesScope(manifest, scope) || manifest.items.length === 0) {
      return null;
    }
    if (expectedManifest && !publicationManifestsMatch(manifest, expectedManifest)) {
      return null;
    }
    if (deadlineExceeded()) return null;
    const { observedEpoch, payloads } = await readDataPublicationPayloadsWithEpoch(
      scope,
      manifest.items.map((item) => item.key),
      redis,
      deadlineAt,
    );
    const items: Record<string, unknown> = {};
    for (let index = 0; index < manifest.items.length; index += 1) {
      if (deadlineExceeded()) return null;
      const item = manifest.items[index];
      const payload = payloads[index];
      if (deadlineExceeded()) return null;
      const payloadBytes = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : -1;
      if (deadlineExceeded()) return null;
      const payloadDigest = typeof payload === 'string' ? sha256(payload) : null;
      if (deadlineExceeded()) return null;
      if (
        typeof payload !== 'string' ||
        payloadBytes !== item.bytes ||
        payloadDigest !== item.sha256
      ) {
        if (deadlineExceeded()) return null;
        await markDataPublicationIntegrityFailure(
          scope,
          manifest,
          redis,
          deadlineAt,
          observedEpoch,
        );
        return null;
      }
      if (deadlineExceeded()) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        if (deadlineExceeded()) return null;
        await markDataPublicationIntegrityFailure(
          scope,
          manifest,
          redis,
          deadlineAt,
          observedEpoch,
        );
        return null;
      }
      if (deadlineExceeded()) return null;
      if (itemCount(parsed) !== item.count) {
        if (deadlineExceeded()) return null;
        await markDataPublicationIntegrityFailure(
          scope,
          manifest,
          redis,
          deadlineAt,
          observedEpoch,
        );
        return null;
      }
      if (deadlineExceeded()) return null;
      items[item.name] = parsed;
    }
    if (deadlineExceeded()) return null;
    await markDataPublicationIntegrityProof(manifest, redis, { fireAndForget: true });
    return { manifest, items };
  } catch {
    return null;
  }
}

/**
 * Read only the active manifest identity for operational control paths.
 *
 * This deliberately does not fetch or hash every publication item. Consumer
 * reads and the explicit governance audit retain full item validation; a
 * frequent health/status request must not turn that audit into a Redis/CPU
 * hot path.
 */
export async function readActiveDataPublicationManifest(
  scope: DataPublicationScope,
  redisClient?: Redis,
  deadlineAt?: number,
): Promise<DataPublicationManifest | null> {
  assertScope(scope);
  try {
    const redis = await getRedisForIntegrityMarker(redisClient, deadlineAt);
    const manifest = parseDataPublicationManifest(
      deadlineAt === undefined
        ? await redis.get(activeDataPublicationKey(scope))
        : await redisCommandWithDeadline<string | null>(
            redis,
            'get',
            [activeDataPublicationKey(scope)],
            deadlineAt,
          ),
    );
    return manifest && assertManifestMatchesScope(manifest, scope) && manifest.items.length > 0
      ? manifest
      : null;
  } catch {
    return null;
  }
}

/**
 * Read a control manifest and check that every declared Redis string still
 * exists with its bounded declared size. Hash validation remains on the
 * consumer read path; this keeps a frequent reconciler from downloading every
 * payload while still detecting missing or truncated siblings.
 */
export type DataPublicationManifestWithItemBoundsResult =
  | { readonly status: 'valid'; readonly manifest: DataPublicationManifest }
  | {
      readonly status: 'missing' | 'invalid' | 'unavailable';
      readonly manifest: null;
    };

export async function readActiveDataPublicationManifestWithItemBoundsStatus(
  scope: DataPublicationScope,
  redisClient?: Redis,
  deadlineAt?: number,
): Promise<DataPublicationManifestWithItemBoundsResult> {
  assertScope(scope);
  try {
    const redis = await getRedisForIntegrityMarker(redisClient, deadlineAt);
    const key = activeDataPublicationKey(scope);
    const redisType = (redis as Redis & { type?: (key: string) => Promise<string> }).type;
    let pointerType: string | undefined;
    if (typeof redisType === 'function') {
      pointerType =
        deadlineAt === undefined
          ? await redisType.call(redis, key)
          : await redisCommandWithDeadline<string>(redis, 'type', [key], deadlineAt);
      if (pointerType === 'none') return { status: 'missing', manifest: null };
      if (pointerType !== 'string') return { status: 'invalid', manifest: null };
    }
    const raw =
      deadlineAt === undefined
        ? await redis.get(key)
        : await redisCommandWithDeadline<string | null>(redis, 'get', [key], deadlineAt);
    if (raw === null) {
      return pointerType === 'string'
        ? { status: 'invalid', manifest: null }
        : { status: 'missing', manifest: null };
    }
    const manifest = parseDataPublicationManifest(raw);
    if (!manifest || !assertManifestMatchesScope(manifest, scope) || manifest.items.length === 0) {
      return { status: 'invalid', manifest: null };
    }
    const results =
      deadlineAt === undefined
        ? await (async () => {
            const pipeline = redis.pipeline();
            for (const item of manifest.items) {
              pipeline.exists(item.key);
              pipeline.strlen(item.key);
            }
            return pipeline.exec();
          })()
        : await (async () => {
            const bounded: Array<[null, number]> = [];
            for (const item of manifest.items) {
              bounded.push([
                null,
                await redisCommandWithDeadline<number>(redis, 'exists', [item.key], deadlineAt),
              ]);
              bounded.push([
                null,
                await redisCommandWithDeadline<number>(redis, 'strlen', [item.key], deadlineAt),
              ]);
            }
            return bounded;
          })();
    if (!results || results.length !== manifest.items.length * 2) {
      return { status: 'invalid', manifest: null };
    }
    for (let index = 0; index < manifest.items.length; index += 1) {
      const exists = results[index * 2];
      const length = results[index * 2 + 1];
      if (
        !exists ||
        exists[0] ||
        Number(exists[1]) !== 1 ||
        !length ||
        length[0] ||
        Number(length[1]) !== manifest.items[index].bytes
      ) {
        return { status: 'invalid', manifest: null };
      }
    }
    // A full consumer may have already proved that this immutable identity is
    // corrupt. Keep manifest-only fallbacks from reporting the publication as
    // usable until the reconciler replaces it or the bounded marker expires.
    if (await hasDataPublicationIntegrityFailure(scope, manifest, redis, deadlineAt)) {
      return { status: 'invalid', manifest: null };
    }
    return { status: 'valid', manifest };
  } catch {
    return { status: 'unavailable', manifest: null };
  }
}

export async function readActiveDataPublicationManifestWithItemBounds(
  scope: DataPublicationScope,
  redisClient?: Redis,
  deadlineAt?: number,
): Promise<DataPublicationManifest | null> {
  const result = await readActiveDataPublicationManifestWithItemBoundsStatus(
    scope,
    redisClient,
    deadlineAt,
  );
  return result.status === 'valid' ? result.manifest : null;
}

/**
 * Read a selected set of active items after checking every sibling's Redis
 * existence and declared size. A publication without the shared full-integrity
 * proof pays one complete validation first; after that proof is tied to the
 * immutable identity, control paths need only the selected payloads. This keeps
 * unselected same-sized corruption from being silently accepted on first use
 * without making every steady-state control pass download the full snapshot.
 */
export async function readActiveDataPublicationItemsWithBounds(
  scope: DataPublicationScope,
  itemNames: readonly string[],
  redisClient?: Redis,
): Promise<DataPublicationReadResult | null> {
  assertScope(scope);
  if (
    itemNames.length === 0 ||
    new Set(itemNames).size !== itemNames.length ||
    itemNames.some((name) => !/^[a-z][a-zA-Z0-9]*$/.test(name))
  ) {
    return null;
  }
  try {
    const manifest = await readActiveDataPublicationManifestWithItemBounds(scope, redisClient);
    if (!manifest) return null;
    const selected = itemNames.map((name) => manifest.items.find((item) => item.name === name));
    if (selected.some((item): item is undefined => item === undefined)) return null;
    const selectedItems = selected as DataPublicationManifest['items'];
    const redis = redisClient ?? (await redisSingleton.getClient());
    const verifiedRead = await readVerifiedDataPublicationPayloads(
      scope,
      manifest,
      selectedItems.map((item) => item.key),
      redis,
    );
    if (verifiedRead.status === 'failure') return null;
    if (verifiedRead.status === 'proof_missing') {
      // Existing active publications may predate the shared proof marker. Pay
      // the complete validation cost once, then keep all steady-state control
      // reads bounded by the marker tied to this immutable identity. This also
      // catches corruption in an unselected sibling before a partial control
      // projection can be used.
      const full = await readActiveDataPublication(scope, redis);
      if (!full) return null;
      return {
        manifest: full.manifest,
        items: Object.fromEntries(itemNames.map((name) => [name, full.items[name]])),
      };
    }
    if (verifiedRead.status !== 'ok') return null;
    const { observedEpoch, payloads } = verifiedRead;
    if (payloads.length !== selectedItems.length) return null;
    const items: Record<string, unknown> = {};
    for (let index = 0; index < selectedItems.length; index += 1) {
      const item = selectedItems[index];
      const payload = payloads[index];
      if (
        payload === null ||
        Buffer.byteLength(payload, 'utf8') !== item.bytes ||
        sha256(payload) !== item.sha256
      ) {
        await markDataPublicationIntegrityFailure(scope, manifest, redis, undefined, observedEpoch);
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        await markDataPublicationIntegrityFailure(scope, manifest, redis, undefined, observedEpoch);
        return null;
      }
      if (itemCount(parsed) !== item.count) {
        await markDataPublicationIntegrityFailure(scope, manifest, redis, undefined, observedEpoch);
        return null;
      }
      items[item.name] = parsed;
    }
    return { manifest, items };
  } catch {
    return null;
  }
}

/**
 * Read one bounded item from the active publication. Control-plane callers
 * should use this when they need a small semantic input (for example the
 * current event fixtures) without downloading every sibling payload.
 */
export async function readActiveDataPublicationItem(
  scope: DataPublicationScope,
  itemName: string,
  redisClient?: Redis,
): Promise<DataPublicationReadResult | null> {
  assertScope(scope);
  if (!/^[a-z][a-zA-Z0-9]*$/.test(itemName)) return null;
  try {
    const redis = redisClient ?? (await redisSingleton.getClient());
    const manifest = parseDataPublicationManifest(await redis.get(activeDataPublicationKey(scope)));
    if (!manifest || !assertManifestMatchesScope(manifest, scope) || manifest.items.length === 0) {
      return null;
    }
    const item = manifest.items.find((candidate) => candidate.name === itemName);
    if (!item) return null;
    const { observedEpoch, payloads } = await readDataPublicationPayloadsWithEpoch(
      scope,
      [item.key],
      redis,
    );
    const payload = payloads[0] ?? null;
    if (
      payload === null ||
      Buffer.byteLength(payload, 'utf8') !== item.bytes ||
      sha256(payload) !== item.sha256
    ) {
      await markDataPublicationIntegrityFailure(scope, manifest, redis, undefined, observedEpoch);
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      await markDataPublicationIntegrityFailure(scope, manifest, redis, undefined, observedEpoch);
      return null;
    }
    if (itemCount(parsed) !== item.count) {
      await markDataPublicationIntegrityFailure(scope, manifest, redis, undefined, observedEpoch);
      return null;
    }
    return { manifest, items: { [itemName]: parsed } };
  } catch {
    return null;
  }
}

/**
 * Read a selected set of items from the active publication. The returned value
 * contains only the requested items, while every manifest sibling is checked
 * against its declared size, checksum, and count before any selected item is
 * consumed. This keeps control-plane callers from retaining large payloads
 * while preserving the publication integrity boundary.
 */
export async function readActiveDataPublicationItems(
  scope: DataPublicationScope,
  itemNames: readonly string[],
  redisClient?: Redis,
): Promise<DataPublicationReadResult | null> {
  assertScope(scope);
  if (
    itemNames.length === 0 ||
    new Set(itemNames).size !== itemNames.length ||
    itemNames.some((name) => !/^[a-z][a-zA-Z0-9]*$/.test(name))
  ) {
    return null;
  }
  try {
    // Client acquisition belongs inside the failure boundary too: startup and
    // reconnect failures must return null so callers can use their durable
    // fallback instead of skipping it on a rejected promise.
    const redis = redisClient ?? (await redisSingleton.getClient());
    const manifest = parseDataPublicationManifest(await redis.get(activeDataPublicationKey(scope)));
    if (!manifest || !assertManifestMatchesScope(manifest, scope) || manifest.items.length === 0) {
      return null;
    }
    const selected = itemNames.map((name) => manifest.items.find((item) => item.name === name));
    if (selected.some((item): item is undefined => item === undefined)) return null;
    const { observedEpoch, payloads } = await readDataPublicationPayloadsWithEpoch(
      scope,
      manifest.items.map((item) => item.key),
      redis,
    );
    const payloadByName = new Map<string, string>();
    for (let index = 0; index < manifest.items.length; index += 1) {
      const item = manifest.items[index];
      const payload = payloads[index];
      if (
        payload === null ||
        Buffer.byteLength(payload, 'utf8') !== item.bytes ||
        sha256(payload) !== item.sha256
      ) {
        await markDataPublicationIntegrityFailure(scope, manifest, redis, undefined, observedEpoch);
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        await markDataPublicationIntegrityFailure(scope, manifest, redis, undefined, observedEpoch);
        return null;
      }
      if (itemCount(parsed) !== item.count) {
        await markDataPublicationIntegrityFailure(scope, manifest, redis, undefined, observedEpoch);
        return null;
      }
      payloadByName.set(item.name, payload);
    }
    const items: Record<string, unknown> = {};
    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index]!;
      const payload = payloadByName.get(item.name);
      if (payload === undefined) return null;
      const parsed = JSON.parse(payload) as unknown;
      items[item.name] = parsed;
    }
    await markDataPublicationIntegrityProof(manifest, redis, { fireAndForget: true });
    return { manifest, items };
  } catch {
    return null;
  }
}

export async function retireActiveDataPublication(
  scope: DataPublicationScope,
  redisClient?: Redis,
): Promise<DataPublicationManifest | null> {
  assertScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  const result = (await redis.eval(
    RETIRE_ACTIVE_REVISION_SCRIPT,
    1,
    activeDataPublicationKey(scope),
    String(DATA_PUBLICATION_RETIRED_TTL_MS),
  )) as [number, string];
  if (Number(result[0]) === -1) {
    throw new CacheError(
      'Cannot retire an invalid active publication manifest',
      'DATA_PUBLICATION_RETIRE_INVALID',
    );
  }
  return parseDataPublicationManifest(result[1]);
}
