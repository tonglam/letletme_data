import { and, asc, eq } from 'drizzle-orm';
import type Redis from 'ioredis';

import {
  parseDataPublicationManifest,
  type DataPublicationManifest,
} from '../cache/data-publication';
import {
  publishLiveSnapshotCache,
  readLiveSnapshotCache,
  type LiveSnapshotCacheContents,
  type LiveSnapshotCachePayload,
} from '../cache/live-snapshot-cache';
import { redisSingleton } from '../cache/singleton';
import { datasetPublicationsInOps, seasonsInFpl } from '../db/schemas/index.schema';
import { databaseSingleton, getDb, getDbClient } from '../db/singleton';
import { assertDataRuntimeRole } from '../db/runtime-role-contract';
import type { EventLive } from '../domain/event-lives';
import type { LiveBonusByTeam } from '../domain/live-bonus';
import type { LiveFixturesByTeam } from '../domain/live-fixtures';
import type { Fixture } from '../types';
import {
  decodeRetiredDataPublicationItems,
  parseRetiredDataPublicationManifest,
  retiredDataActivePattern,
  type ActivePublicationIdentity,
} from './retired-data-publication.service';

type ActiveLivePublicationRow = {
  readonly publicationId: string;
  readonly seasonId: number;
  readonly seasonCode: string;
  readonly eventId: number;
  readonly revision: number;
  readonly manifest: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function parseDatabaseManifest(row: ActiveLivePublicationRow): DataPublicationManifest {
  const manifest = parseDataPublicationManifest(JSON.stringify(row.manifest));
  if (
    !manifest ||
    manifest.dataset !== 'fpl:live' ||
    manifest.seasonCode !== row.seasonCode ||
    manifest.eventId !== row.eventId ||
    manifest.revision !== row.revision ||
    manifest.publicationId !== row.publicationId
  ) {
    throw new Error(
      `Active live publication ${row.publicationId} has an invalid canonical database manifest`,
    );
  }
  return manifest;
}

function assertLiveCacheIdentity(
  cached: LiveSnapshotCacheContents,
  expected: ActivePublicationIdentity,
): void {
  if (
    cached.season !== expected.seasonCode ||
    cached.eventId !== expected.eventId ||
    cached.state !== expected.state ||
    cached.manifest.publicationId !== expected.publicationId ||
    cached.manifest.revision !== expected.revision
  ) {
    throw new Error(
      `Canonical live cache does not match PostgreSQL publication ${expected.publicationId}`,
    );
  }
}

export function assertImmutableLiveManifestMatch(
  databaseManifest: DataPublicationManifest,
  cachedManifest: DataPublicationManifest,
): void {
  const databaseItems = databaseManifest.items.map(({ name, key, type, count, bytes, sha256 }) => ({
    name,
    key,
    type,
    count,
    bytes,
    sha256,
  }));
  const cachedItems = cachedManifest.items.map(({ name, key, type, count, bytes, sha256 }) => ({
    name,
    key,
    type,
    count,
    bytes,
    sha256,
  }));
  if (
    databaseManifest.dataset !== cachedManifest.dataset ||
    databaseManifest.seasonCode !== cachedManifest.seasonCode ||
    databaseManifest.eventId !== cachedManifest.eventId ||
    databaseManifest.revision !== cachedManifest.revision ||
    databaseManifest.publicationId !== cachedManifest.publicationId ||
    databaseManifest.state !== cachedManifest.state ||
    JSON.stringify(databaseItems) !== JSON.stringify(cachedItems)
  ) {
    throw new Error(
      `Canonical live cache manifest differs from PostgreSQL publication ${databaseManifest.publicationId}`,
    );
  }
}

function toLivePayload(
  expected: ActivePublicationIdentity,
  items: Readonly<Record<string, unknown>>,
): LiveSnapshotCachePayload {
  if (
    !Array.isArray(items.eventLives) ||
    !Array.isArray(items.fixtures) ||
    !isRecord(items.liveFixtures) ||
    !isRecord(items.liveBonus) ||
    expected.eventId === null ||
    expected.state === 'active'
  ) {
    throw new Error(`Retired live payload is invalid for publication ${expected.publicationId}`);
  }
  return {
    season: expected.seasonCode,
    eventId: expected.eventId,
    state: expected.state,
    eventLives: items.eventLives as EventLive[],
    fixtures: items.fixtures as Fixture[],
    liveFixtures: items.liveFixtures as LiveFixturesByTeam,
    liveBonus: items.liveBonus as LiveBonusByTeam,
  };
}

async function persistManifest(
  row: ActiveLivePublicationRow,
  manifest: DataPublicationManifest,
): Promise<void> {
  const db = await getDb();
  const updated = await db
    .update(datasetPublicationsInOps)
    .set({ manifest, updatedAt: new Date() })
    .where(
      and(
        eq(datasetPublicationsInOps.publicationId, row.publicationId),
        eq(datasetPublicationsInOps.dataset, 'fpl:live'),
        eq(datasetPublicationsInOps.seasonId, row.seasonId),
        eq(datasetPublicationsInOps.eventId, row.eventId),
        eq(datasetPublicationsInOps.revision, row.revision),
        eq(datasetPublicationsInOps.status, 'active'),
      ),
    )
    .returning({ publicationId: datasetPublicationsInOps.publicationId });
  if (updated.length !== 1) {
    throw new Error(`Active live publication changed while republishing ${row.publicationId}`);
  }
}

export async function publishActiveLiveCachesForDeployment(execute: boolean): Promise<{
  readonly operation: 'publish-active-live-caches';
  readonly executed: boolean;
  readonly activePublicationCount: number;
  readonly publications: readonly {
    readonly publicationId: string;
    readonly seasonCode: string;
    readonly eventId: number;
    readonly revision: number;
    readonly action: 'reuse' | 'republish';
  }[];
}> {
  try {
    const db = await getDb();
    await assertDataRuntimeRole(await getDbClient());
    const redis = await redisSingleton.getClient();
    const rows = await db
      .select({
        publicationId: datasetPublicationsInOps.publicationId,
        seasonId: datasetPublicationsInOps.seasonId,
        seasonCode: seasonsInFpl.seasonCode,
        eventId: datasetPublicationsInOps.eventId,
        revision: datasetPublicationsInOps.revision,
        manifest: datasetPublicationsInOps.manifest,
      })
      .from(datasetPublicationsInOps)
      .innerJoin(seasonsInFpl, eq(seasonsInFpl.seasonId, datasetPublicationsInOps.seasonId))
      .where(
        and(
          eq(datasetPublicationsInOps.dataset, 'fpl:live'),
          eq(datasetPublicationsInOps.status, 'active'),
        ),
      )
      .orderBy(asc(seasonsInFpl.seasonCode), asc(datasetPublicationsInOps.eventId));

    const publications: Array<{
      readonly publicationId: string;
      readonly seasonCode: string;
      readonly eventId: number;
      readonly revision: number;
      readonly action: 'reuse' | 'republish';
    }> = [];

    for (const candidate of rows) {
      if (candidate.seasonId === null || candidate.eventId === null) {
        throw new Error(`Active live publication ${candidate.publicationId} has an invalid scope`);
      }
      const row: ActiveLivePublicationRow = {
        ...candidate,
        seasonId: candidate.seasonId,
        eventId: candidate.eventId,
      };
      const databaseManifest = parseDatabaseManifest(row);
      const expected: ActivePublicationIdentity = {
        dataset: 'fpl:live',
        seasonCode: row.seasonCode,
        eventId: row.eventId,
        revision: row.revision,
        publicationId: row.publicationId,
        state: databaseManifest.state,
      };
      const existing = await readLiveSnapshotCache(row.seasonCode, row.eventId, redis);
      if (existing) {
        assertLiveCacheIdentity(existing, expected);
        assertImmutableLiveManifestMatch(databaseManifest, existing.manifest);
        if (execute) await persistManifest(row, existing.manifest);
        publications.push({ ...expected, eventId: row.eventId, action: 'reuse' });
        continue;
      }

      const activeKeys = await scan(redis, retiredDataActivePattern(expected));
      if (activeKeys.length !== 1) {
        throw new Error(
          `Expected one retired live cache for ${row.seasonCode}/${row.eventId}, found ${activeKeys.length}`,
        );
      }
      const activeKey = activeKeys[0];
      const retiredManifest = parseRetiredDataPublicationManifest(
        activeKey,
        await redis.get(activeKey),
        expected,
      );
      const items = decodeRetiredDataPublicationItems(
        retiredManifest,
        await redis.mget(...retiredManifest.items.map((item) => item.key)),
      );
      const payload = toLivePayload(expected, items);

      if (execute) {
        const published = await publishLiveSnapshotCache(payload, {
          redis,
          revision: row.revision,
          publicationId: row.publicationId,
          sourceCheckedAt: new Date(retiredManifest.sourceCheckedAt),
          beforeActivate: async () => {
            const current = await db
              .select({ publicationId: datasetPublicationsInOps.publicationId })
              .from(datasetPublicationsInOps)
              .where(
                and(
                  eq(datasetPublicationsInOps.publicationId, row.publicationId),
                  eq(datasetPublicationsInOps.dataset, 'fpl:live'),
                  eq(datasetPublicationsInOps.seasonId, row.seasonId),
                  eq(datasetPublicationsInOps.eventId, row.eventId),
                  eq(datasetPublicationsInOps.revision, row.revision),
                  eq(datasetPublicationsInOps.status, 'active'),
                ),
              )
              .limit(2);
            return current.length === 1;
          },
        });
        if (!published.published) {
          throw new Error(
            `Canonical live publication lost its database fence: ${row.publicationId}`,
          );
        }
        const verified = await readLiveSnapshotCache(row.seasonCode, row.eventId, redis);
        if (!verified) {
          throw new Error(`Canonical live publication failed read-back: ${row.publicationId}`);
        }
        assertLiveCacheIdentity(verified, expected);
        await persistManifest(row, verified.manifest);
      }
      publications.push({ ...expected, eventId: row.eventId, action: 'republish' });
    }

    return {
      operation: 'publish-active-live-caches',
      executed: execute,
      activePublicationCount: publications.length,
      publications,
    };
  } finally {
    await Promise.allSettled([redisSingleton.disconnect(), databaseSingleton.disconnect()]);
  }
}
