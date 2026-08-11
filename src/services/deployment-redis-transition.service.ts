import { and, asc, eq, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';

import { readCoreSnapshotCache } from '../cache/core-snapshot-cache';
import {
  parseDataPublicationManifest,
  type DataPublicationManifest,
} from '../cache/data-publication';
import { readLiveSnapshotCache } from '../cache/live-snapshot-cache';
import { redisSingleton } from '../cache/singleton';
import { datasetPublicationsInOps, seasonsInFpl } from '../db/schemas/index.schema';
import { databaseSingleton, getDb, getDbClient } from '../db/singleton';
import { assertDataRuntimeRole } from '../db/runtime-role-contract';
import { queueRedisSingleton } from '../queues/redis';
import {
  isRetiredDataKey,
  parseRetiredDataActiveKeyScope,
  parseRetiredDataPublicationManifest,
  type ActivePublicationIdentity,
} from './retired-data-publication.service';

const RETIRED_COORDINATION_PATTERN = 'llm:v*:queue:coordination:*';
const RETIRED_DATA_PATTERN = 'llm:v*:data:*';

const MOVE_COORDINATION_KEYS_SCRIPT = `
local movable = {}
for index = 1, #KEYS, 2 do
  local source = KEYS[index]
  local target = KEYS[index + 1]
  if redis.call('EXISTS', source) == 1 then
    if redis.call('EXISTS', target) ~= 0 then return {'target_exists', target} end
    table.insert(movable, source)
    table.insert(movable, target)
  end
end
for index = 1, #movable, 2 do
  redis.call('RENAME', movable[index], movable[index + 1])
end
return {'migrated', tostring(#movable / 2)}
`;

type ActivePublicationRow = {
  readonly publicationId: string;
  readonly dataset: 'fpl:core' | 'fpl:live';
  readonly seasonCode: string;
  readonly eventId: number | null;
  readonly revision: number;
  readonly manifest: unknown;
};

export function canonicalCoordinationKey(source: string): string | null {
  const match = /^llm:v[0-9]+:queue:coordination:(.+)$/.exec(source);
  return match ? `llm:queue:coordination:${match[1]}` : null;
}

export function buildCoordinationMigrationPairs(
  sources: readonly string[],
): readonly { readonly source: string; readonly target: string }[] {
  const pairs = [...new Set(sources)].sort().map((source) => {
    const target = canonicalCoordinationKey(source);
    if (!target) throw new Error(`Unexpected retired coordination key: ${source}`);
    return { source, target };
  });
  const targets = new Set<string>();
  for (const pair of pairs) {
    if (targets.has(pair.target)) {
      throw new Error(`Multiple retired coordination keys map to ${pair.target}`);
    }
    targets.add(pair.target);
  }
  return pairs;
}

async function scan(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 250);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return [...new Set(keys)].sort();
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function sameManifest(left: DataPublicationManifest, right: DataPublicationManifest): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function publicationScopeKey(
  publication: Pick<ActivePublicationIdentity, 'dataset' | 'seasonCode' | 'eventId'>,
): string {
  return `${publication.dataset}:${publication.seasonCode}:${publication.eventId ?? 'core'}`;
}

function parseActivePublication(row: ActivePublicationRow): {
  readonly identity: ActivePublicationIdentity;
  readonly manifest: DataPublicationManifest;
} {
  const manifest = parseDataPublicationManifest(JSON.stringify(row.manifest));
  if (
    !manifest ||
    manifest.dataset !== row.dataset ||
    manifest.seasonCode !== row.seasonCode ||
    manifest.eventId !== row.eventId ||
    manifest.revision !== row.revision ||
    manifest.publicationId !== row.publicationId
  ) {
    throw new Error(`Active publication ${row.publicationId} has an invalid database manifest`);
  }
  return {
    manifest,
    identity: {
      dataset: row.dataset,
      seasonCode: row.seasonCode,
      eventId: row.eventId,
      revision: row.revision,
      publicationId: row.publicationId,
      state: manifest.state,
    },
  };
}

async function assertCanonicalPublication(
  redis: Redis,
  publication: ReturnType<typeof parseActivePublication>,
): Promise<void> {
  const { identity, manifest } = publication;
  const cached =
    identity.dataset === 'fpl:core'
      ? await readCoreSnapshotCache(identity.seasonCode, redis)
      : await readLiveSnapshotCache(identity.seasonCode, identity.eventId ?? 0, redis);
  if (!cached || !sameManifest(cached.manifest, manifest)) {
    throw new Error(
      `Canonical cache does not exactly match active database publication ${identity.publicationId}`,
    );
  }
}

async function assertCoordinationTargetsAbsent(
  redis: Redis,
  pairs: readonly { readonly target: string }[],
): Promise<void> {
  if (pairs.length === 0) return;
  const pipeline = redis.pipeline();
  pairs.forEach((pair) => pipeline.exists(pair.target));
  const results = await pipeline.exec();
  if (!results || results.length !== pairs.length) {
    throw new Error('Could not inspect canonical coordination targets');
  }
  results.forEach(([error, value], index) => {
    if (error) throw error;
    if (Number(value) !== 0) {
      throw new Error(`Canonical coordination target already exists: ${pairs[index].target}`);
    }
  });
}

export async function moveCoordinationKeys(
  redis: Redis,
  pairs: readonly { readonly source: string; readonly target: string }[],
): Promise<number> {
  if (pairs.length === 0) return 0;
  const keys = pairs.flatMap((pair) => [pair.source, pair.target]);
  const result = (await redis.eval(MOVE_COORDINATION_KEYS_SCRIPT, keys.length, ...keys)) as [
    string,
    string,
  ];
  const migrated = Number(result[1]);
  if (
    result[0] !== 'migrated' ||
    !Number.isSafeInteger(migrated) ||
    migrated < 0 ||
    migrated > pairs.length
  ) {
    throw new Error(`Atomic coordination migration failed: ${result.join(':')}`);
  }
  return migrated;
}

async function unlinkBatches(redis: Redis, keys: readonly string[]): Promise<number> {
  let deleted = 0;
  for (let index = 0; index < keys.length; index += 250) {
    deleted += await redis.unlink(...keys.slice(index, index + 250));
  }
  return deleted;
}

export async function migrateRetiredRedisStateForDeployment(execute: boolean): Promise<{
  readonly operation: 'migrate-retired-redis-state';
  readonly executed: boolean;
  readonly canonicalPublicationCount: number;
  readonly movedCoordinationKeys: number;
  readonly plannedCoordinationKeys: number;
  readonly deletedDataKeys: number;
  readonly plannedDataKeys: number;
}> {
  try {
    const db = await getDb();
    await assertDataRuntimeRole(await getDbClient());
    const [cacheRedis, queueRedis] = await Promise.all([
      redisSingleton.getClient(),
      queueRedisSingleton.getClient(),
    ]);
    const activeRows = await db
      .select({
        publicationId: datasetPublicationsInOps.publicationId,
        dataset: datasetPublicationsInOps.dataset,
        seasonCode: seasonsInFpl.seasonCode,
        eventId: datasetPublicationsInOps.eventId,
        revision: datasetPublicationsInOps.revision,
        manifest: datasetPublicationsInOps.manifest,
      })
      .from(datasetPublicationsInOps)
      .innerJoin(seasonsInFpl, eq(seasonsInFpl.seasonId, datasetPublicationsInOps.seasonId))
      .where(
        and(
          eq(datasetPublicationsInOps.status, 'active'),
          inArray(datasetPublicationsInOps.dataset, ['fpl:core', 'fpl:live']),
        ),
      )
      .orderBy(
        asc(datasetPublicationsInOps.dataset),
        asc(seasonsInFpl.seasonCode),
        asc(datasetPublicationsInOps.eventId),
      );
    const rows: ActivePublicationRow[] = activeRows.map((row) => {
      if (row.dataset !== 'fpl:core' && row.dataset !== 'fpl:live') {
        throw new Error(`Unexpected active publication dataset: ${row.dataset}`);
      }
      return { ...row, dataset: row.dataset };
    });
    const publications = rows.map(parseActivePublication);
    if (publications.filter(({ identity }) => identity.dataset === 'fpl:core').length !== 1) {
      throw new Error('Exactly one canonical active core publication is required');
    }
    await Promise.all(
      publications.map((publication) => assertCanonicalPublication(cacheRedis, publication)),
    );

    const [retiredDataKeys, retiredCoordinationKeys] = await Promise.all([
      scan(cacheRedis, RETIRED_DATA_PATTERN),
      scan(queueRedis, RETIRED_COORDINATION_PATTERN),
    ]);
    const unexpectedDataKey = retiredDataKeys.find((key) => !isRetiredDataKey(key));
    if (unexpectedDataKey) {
      throw new Error(`Refusing to delete an unexpected retired Data key: ${unexpectedDataKey}`);
    }

    const publicationByScope = new Map(
      publications.map((publication) => [publicationScopeKey(publication.identity), publication]),
    );
    const oldActiveScopes = new Set<string>();
    for (const key of retiredDataKeys.filter((candidate) => candidate.endsWith(':active'))) {
      const scope = parseRetiredDataActiveKeyScope(key);
      if (!scope) throw new Error(`Retired Data active key has an unknown scope: ${key}`);
      const scopeKey = publicationScopeKey(scope);
      if (oldActiveScopes.has(scopeKey)) {
        throw new Error(`Multiple retired active keys exist for ${scopeKey}`);
      }
      const active = publicationByScope.get(scopeKey);
      if (!active) throw new Error(`Retired Data active key has no database authority: ${key}`);
      parseRetiredDataPublicationManifest(key, await cacheRedis.get(key), active.identity);
      oldActiveScopes.add(scopeKey);
    }

    const coordinationPairs = buildCoordinationMigrationPairs(retiredCoordinationKeys);
    await assertCoordinationTargetsAbsent(queueRedis, coordinationPairs);

    let deletedDataKeys = 0;
    let movedCoordinationKeys = 0;
    if (execute) {
      movedCoordinationKeys = await moveCoordinationKeys(queueRedis, coordinationPairs);
      deletedDataKeys = await unlinkBatches(cacheRedis, retiredDataKeys);
      const [remainingData, remainingCoordination] = await Promise.all([
        scan(cacheRedis, RETIRED_DATA_PATTERN),
        scan(queueRedis, RETIRED_COORDINATION_PATTERN),
      ]);
      if (remainingData.length > 0 || remainingCoordination.length > 0) {
        throw new Error('Retired Redis namespace still contains keys after transition');
      }
    }

    return {
      operation: 'migrate-retired-redis-state',
      executed: execute,
      canonicalPublicationCount: publications.length,
      movedCoordinationKeys,
      plannedCoordinationKeys: coordinationPairs.length,
      deletedDataKeys,
      plannedDataKeys: retiredDataKeys.length,
    };
  } finally {
    await Promise.allSettled([
      redisSingleton.disconnect(),
      queueRedisSingleton.disconnect(),
      databaseSingleton.disconnect(),
    ]);
  }
}
