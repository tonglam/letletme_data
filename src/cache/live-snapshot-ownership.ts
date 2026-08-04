import type Redis from 'ioredis';

export const LIVE_SNAPSHOT_META_PREFIX = 'LiveSnapshotMeta';

export interface SnapshotOwnedHashReplacement {
  eventId: number;
  key: string;
  fields: Readonly<Record<string, string>>;
}

/**
 * A published metadata key makes the six live hashes for that event exclusively
 * owned by the snapshot publisher. Compatibility cache writers may still own
 * events that have never published a snapshot, but they must not mutate one
 * snapshot view independently after metadata exists.
 *
 * The ownership check and optional replacement happen in one Redis script so a
 * snapshot publication cannot race between an EXISTS check and a legacy write.
 */
const REPLACE_HASHES_UNLESS_SNAPSHOT_OWNED_SCRIPT = `
local statuses = {}

for index = 1, #ARGV do
  local meta_index = ((index - 1) * 2) + 1
  local target_index = meta_index + 1

  if redis.call('EXISTS', KEYS[meta_index]) == 1 then
    statuses[index] = 0
  else
    redis.call('DEL', KEYS[target_index])
    local fields = cjson.decode(ARGV[index])
    for field, value in pairs(fields) do
      redis.call('HSET', KEYS[target_index], field, value)
    end
    statuses[index] = 1
  end
end

return statuses
`;

export function liveSnapshotMetaKey(season: string, eventId: number): string {
  return `${LIVE_SNAPSHOT_META_PREFIX}:${season}:${eventId}`;
}

export async function replaceHashesUnlessLiveSnapshotOwned(
  redis: Redis,
  season: string,
  replacements: readonly SnapshotOwnedHashReplacement[],
): Promise<Set<number>> {
  if (replacements.length === 0) return new Set();

  const keys = replacements.flatMap(({ eventId, key }) => [
    liveSnapshotMetaKey(season, eventId),
    key,
  ]);
  const payloads = replacements.map(({ fields }) => JSON.stringify(fields));
  const rawStatuses = await redis.eval(
    REPLACE_HASHES_UNLESS_SNAPSHOT_OWNED_SCRIPT,
    keys.length,
    ...keys,
    ...payloads,
  );

  if (!Array.isArray(rawStatuses) || rawStatuses.length !== replacements.length) {
    throw new Error('Unexpected snapshot ownership guard result');
  }

  const snapshotOwnedEventIds = new Set<number>();
  rawStatuses.forEach((rawStatus, index) => {
    const status = Number(rawStatus);
    if (status === 0) {
      snapshotOwnedEventIds.add(replacements[index].eventId);
    } else if (status !== 1) {
      throw new Error(`Unexpected snapshot ownership guard status: ${String(rawStatus)}`);
    }
  });
  return snapshotOwnedEventIds;
}
