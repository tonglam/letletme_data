import { createHash } from 'node:crypto';

import type Redis from 'ioredis';

import { canonicalJson } from '../utils/content-hash';
import { CacheError } from '../utils/errors';
import { redisSingleton } from './singleton';

export const DATA_CACHE_NAMESPACE = 'llm:data';
export const DATA_PUBLICATION_STAGING_TTL_MS = 15 * 60 * 1_000;
export const DATA_PUBLICATION_RETIRED_TTL_MS = 24 * 60 * 60 * 1_000;

export function isDataPublicationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export type DataPublicationDataset = 'fpl:core' | 'fpl:live' | 'fpl:market';
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
export type DataPublicationState = 'active' | 'scheduled' | 'live' | 'settled';

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
  readonly state: DataPublicationState;
  readonly items: readonly DataPublicationItemInput[];
}

export interface PublishDataRevisionOptions {
  readonly redis?: Redis;
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
const MANIFEST_ITEM_FIELDS = ['name', 'key', 'type', 'count', 'bytes', 'sha256'] as const;
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
  'fpl:live': ['eventLive', 'fixtures'],
  'fpl:market': ['context'],
};
const LEGACY_CORE_ITEM_NAMES = [
  'events',
  'teams',
  'players',
  'phases',
  'fixtures',
  'currentEventId',
];

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
  if (dataset === 'fpl:core' || dataset === 'fpl:market') return state === 'active';
  return state === 'scheduled' || state === 'live' || state === 'settled';
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

function assertScope(scope: DataPublicationScope): void {
  if (!/^\d{4}$/.test(scope.seasonCode)) {
    throw new CacheError('Invalid publication season', 'DATA_PUBLICATION_SEASON_INVALID');
  }
  if (scope.dataset === 'fpl:live') {
    if (!Number.isInteger(scope.eventId) || (scope.eventId ?? 0) <= 0) {
      throw new CacheError(
        'A live publication requires a positive event ID',
        'DATA_PUBLICATION_EVENT_INVALID',
      );
    }
    return;
  }
  if (scope.eventId !== undefined) {
    throw new CacheError(
      'A core publication cannot have an event ID',
      'DATA_PUBLICATION_CORE_EVENT_INVALID',
    );
  }
}

function scopePrefix(scope: DataPublicationScope): string {
  assertScope(scope);
  return scope.dataset === 'fpl:live'
    ? `${DATA_CACHE_NAMESPACE}:${scope.dataset}:${scope.seasonCode}:${scope.eventId}`
    : `${DATA_CACHE_NAMESPACE}:${scope.dataset}:${scope.seasonCode}`;
}

export function activeDataPublicationKey(scope: DataPublicationScope): string {
  return `${scopePrefix(scope)}:active`;
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
  const sourceCheckedAt = input.sourceCheckedAt.toISOString();
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
    publishedAt: new Date().toISOString(),
    state: input.state,
    items: items.map((item) => item.manifest),
  };
}

export function parseDataPublicationManifest(raw: string | null): DataPublicationManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !hasExactFields(value, MANIFEST_FIELDS)) return null;
    if (
      value.dataset !== 'fpl:core' &&
      value.dataset !== 'fpl:live' &&
      value.dataset !== 'fpl:market'
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
      typeof value.publishedAt !== 'string' ||
      !Number.isFinite(new Date(value.publishedAt).getTime()) ||
      !isCanonicalState(dataset, value.state) ||
      !Array.isArray(value.items)
    ) {
      return null;
    }
    if (
      ((dataset === 'fpl:core' || dataset === 'fpl:market') && value.eventId !== null) ||
      (dataset === 'fpl:live' &&
        (typeof value.eventId !== 'number' ||
          !Number.isSafeInteger(value.eventId) ||
          value.eventId <= 0))
    ) {
      return null;
    }
    const scope: DataPublicationScope = {
      dataset,
      seasonCode: value.seasonCode,
      ...(dataset === 'fpl:live' ? { eventId: value.eventId as number } : {}),
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
  assertScope(input);
  const redis = options.redis ?? (await redisSingleton.getClient());
  const serialized = serializeItems(input);
  const manifest = createManifest(input, serialized);
  const activeKey = activeDataPublicationKey(input);

  const stage = redis.pipeline();
  for (const item of serialized) {
    // Revision item keys are immutable. NX prevents an idempotent retry from
    // overwriting an already-active item and accidentally adding a staging TTL.
    stage.set(item.manifest.key, item.payload, 'PX', DATA_PUBLICATION_STAGING_TTL_MS, 'NX');
  }
  const stageResults = await stage.exec();
  if (!stageResults) {
    throw new CacheError('Publication staging returned no result', 'DATA_PUBLICATION_STAGE_FAILED');
  }
  const stageError = stageResults?.find(([error]) => error)?.[0];
  if (stageError) throw stageError;

  // Existing keys are valid only for an exact idempotent retry. This also
  // rejects partial/colliding stages before the manifest pointer can move.
  const stagedPayloads = await redis.mget(...serialized.map((item) => item.manifest.key));
  for (let index = 0; index < serialized.length; index += 1) {
    if (stagedPayloads[index] !== serialized[index].payload) {
      throw new CacheError(
        `Publication stage conflicts with immutable item ${serialized[index].manifest.name}`,
        'DATA_PUBLICATION_STAGE_CONFLICT',
      );
    }
  }
  await options.afterStage?.(manifest);

  const accepted = (await options.beforeActivate?.()) !== false;
  if (!accepted) {
    return { status: 'stale', manifest, previousManifest: null };
  }

  const rawResult = (await redis.eval(
    ACTIVATE_REVISION_SCRIPT,
    1,
    activeKey,
    JSON.stringify(manifest),
    String(DATA_PUBLICATION_RETIRED_TTL_MS),
  )) as [string, string?];
  const [status, detail = ''] = rawResult;
  if (status === 'idempotent') {
    const activeManifest = parseDataPublicationManifest(detail);
    if (!activeManifest || !assertManifestMatchesScope(activeManifest, input)) {
      throw new CacheError(
        'Idempotent publication returned an invalid active manifest',
        'DATA_PUBLICATION_ACTIVATION_FAILED',
      );
    }
    return {
      status: 'published',
      manifest: activeManifest,
      previousManifest: null,
    };
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
  return {
    status: 'published',
    manifest,
    previousManifest: parseDataPublicationManifest(detail),
  };
}

export async function readActiveDataPublication(
  scope: DataPublicationScope,
  redisClient?: Redis,
): Promise<DataPublicationReadResult | null> {
  assertScope(scope);
  const redis = redisClient ?? (await redisSingleton.getClient());
  try {
    const manifest = parseDataPublicationManifest(await redis.get(activeDataPublicationKey(scope)));
    if (!manifest || !assertManifestMatchesScope(manifest, scope) || manifest.items.length === 0) {
      return null;
    }
    const payloads = await redis.mget(...manifest.items.map((item) => item.key));
    const items: Record<string, unknown> = {};
    for (let index = 0; index < manifest.items.length; index += 1) {
      const item = manifest.items[index];
      const payload = payloads[index];
      if (
        payload === null ||
        Buffer.byteLength(payload, 'utf8') !== item.bytes ||
        sha256(payload) !== item.sha256
      ) {
        return null;
      }
      const parsed = JSON.parse(payload) as unknown;
      if (itemCount(parsed) !== item.count) return null;
      items[item.name] = parsed;
    }
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
