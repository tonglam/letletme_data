import type Redis from 'ioredis';

const EXACT_ORDERING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const PUBLISH_MANAGER_LIVE_ROWS_SCRIPT = `
local publication_order = ARGV[1]
local ttl_seconds = tonumber(ARGV[2])
local metadata_field = ARGV[3]
local metadata_payload = ARGV[4]
local row_count = tonumber(ARGV[5])
local argument_index = 6
local updated_entry_ids = {}
local marker_written = false

for _ = 1, row_count do
  local entry_id = ARGV[argument_index]
  local row_payload = ARGV[argument_index + 1]
  local overall_rank_order = ARGV[argument_index + 2]
  local current_order = redis.call('HGET', KEYS[3], entry_id)

  if (not current_order) or current_order < publication_order then
    redis.call('HSET', KEYS[1], entry_id, row_payload)
    redis.call('HSET', KEYS[3], entry_id, publication_order)
    if overall_rank_order ~= '' then
      redis.call('HSET', KEYS[4], entry_id, overall_rank_order)
      marker_written = true
    end
    table.insert(updated_entry_ids, entry_id)
  end

  argument_index = argument_index + 3
end

if #updated_entry_ids > 0 then
  redis.call('EXPIRE', KEYS[1], ttl_seconds)
  redis.call('EXPIRE', KEYS[3], ttl_seconds)
end
if marker_written then
  redis.call('EXPIRE', KEYS[4], ttl_seconds)
end

if metadata_payload ~= '' then
  local metadata_order_field = '__manager_live_order__:' .. metadata_field
  local current_metadata_order = redis.call('HGET', KEYS[2], metadata_order_field)
  if (not current_metadata_order) or current_metadata_order < publication_order then
    redis.call('HSET', KEYS[2], metadata_field, metadata_payload)
    redis.call('HSET', KEYS[2], metadata_order_field, publication_order)
    redis.call('EXPIRE', KEYS[2], ttl_seconds)
  end
end

return updated_entry_ids
`;

export type ManagerLiveCachePublicationRow = Readonly<{
  entryId: number;
  payload: string;
  overallRankPublicationOrder?: string | null;
}>;

export type ManagerLiveCachePublicationInput = Readonly<{
  rowKey: string;
  metadataKey: string;
  rowOrderKey: string;
  overallRankMarkerKey: string;
  publicationOrder: string;
  rows: readonly ManagerLiveCachePublicationRow[];
  metadataField: string;
  metadataPayload: string;
  ttlSeconds: number;
}>;

const assertOrderingTimestamp = (value: string, label: string): void => {
  if (!EXACT_ORDERING_TIMESTAMP.test(value)) {
    throw new TypeError(`${label} must be an exact six-digit UTC ordering timestamp`);
  }
};

export async function publishManagerLiveCacheMonotonically(
  redis: Redis,
  input: ManagerLiveCachePublicationInput,
): Promise<readonly number[]> {
  assertOrderingTimestamp(input.publicationOrder, 'publicationOrder');
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new RangeError('ttlSeconds must be a positive integer');
  }

  const seenEntryIds = new Set<number>();
  const rowArguments: string[] = [];
  for (const row of input.rows) {
    if (!Number.isSafeInteger(row.entryId) || row.entryId <= 0) {
      throw new RangeError('manager-live cache entry IDs must be positive safe integers');
    }
    if (seenEntryIds.has(row.entryId)) {
      throw new RangeError(`duplicate manager-live cache entry ID: ${row.entryId}`);
    }
    seenEntryIds.add(row.entryId);
    if (row.overallRankPublicationOrder) {
      assertOrderingTimestamp(
        row.overallRankPublicationOrder,
        `overallRankPublicationOrder for entry ${row.entryId}`,
      );
    }
    rowArguments.push(String(row.entryId), row.payload, row.overallRankPublicationOrder ?? '');
  }

  const rawResult = await redis.eval(
    PUBLISH_MANAGER_LIVE_ROWS_SCRIPT,
    4,
    input.rowKey,
    input.metadataKey,
    input.rowOrderKey,
    input.overallRankMarkerKey,
    input.publicationOrder,
    String(input.ttlSeconds),
    input.metadataField,
    input.metadataPayload,
    String(input.rows.length),
    ...rowArguments,
  );
  if (!Array.isArray(rawResult)) {
    throw new TypeError('Redis manager-live publication returned an invalid result');
  }
  const updatedEntryIds = rawResult.map((value) => Number(value));
  if (
    updatedEntryIds.some((entryId) => !Number.isSafeInteger(entryId) || !seenEntryIds.has(entryId))
  ) {
    throw new TypeError('Redis manager-live publication returned invalid entry IDs');
  }
  return updatedEntryIds;
}
