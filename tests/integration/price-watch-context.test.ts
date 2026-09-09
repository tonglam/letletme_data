import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();

import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import Redis from 'ioredis';
import { activeDataPublicationKey, prepareDataPublication } from '../../src/cache/data-publication';
import { databaseSingleton } from '../../src/db/singleton';
import { loadActivePriceChangeContext } from '../../src/repositories/data-publication-outbox';
import { syncOperationsRepository } from '../../src/repositories/sync-operations';
import { getPriceChangeWatchDeadlines } from '../../src/services/price-change-predictions.service';

const db = postgres(process.env.DATABASE_URL!, { max: 1 });
const redis = new Redis({
  host: process.env.CACHE_REDIS_HOST,
  port: Number(process.env.CACHE_REDIS_PORT),
  password: process.env.CACHE_REDIS_PASSWORD,
  db: Number(process.env.CACHE_REDIS_DB),
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});
const season = { seasonId: 2093, seasonCode: '9394' };
const now = new Date('2093-08-22T00:00:00Z');
const publicationId = '00000000-0000-4000-8000-000000009394';
const context = {
  schemaVersion: 2,
  source: 'FPL_BOOTSTRAP',
  fetchedAt: now.toISOString(),
  staleAt: '2093-08-22T00:10:00.000Z',
  hardExpiresAt: '2093-08-22T01:00:00.000Z',
  deadline: '2093-08-22T01:30:00.000Z',
  nextDeadlines: ['2093-08-22T01:30:00.000Z'],
  expectedPlayerCount: 1,
  observedPlayerCount: 1,
  latestEvent: null,
};
const prepared = prepareDataPublication({
  dataset: 'fpl:price-changes',
  seasonCode: season.seasonCode,
  revision: 9394,
  publicationId,
  sourceCheckedAt: now,
  state: 'active',
  items: [
    { name: 'context', value: context },
    { name: 'players', value: [{ unused: 'x'.repeat(400000) }] },
  ],
});
beforeAll(async () => {
  await redis.connect();
  await db`INSERT INTO fpl.seasons (season_id, season_code, display_name, start_year, end_year, lifecycle_state)
    VALUES (2093, '9394', '2093/94', 2093, 2094, 'reference_only')`;
});
beforeEach(async () => {
  await db`DELETE FROM ops.dataset_publications WHERE publication_id=${publicationId}`;
  await db`INSERT INTO ops.dataset_publications (publication_id, dataset, season_id, revision, status, activated_at, manifest)
    VALUES (${publicationId}, 'fpl:price-changes', 2093, 9394, 'active', now(), ${db.json(prepared.manifest as never)})`;
  for (const item of prepared.items) {
    await db`INSERT INTO ops.dataset_publication_items (publication_id,item_name,payload,item_count,checksum)
      VALUES (${publicationId},${item.manifest.name},${db.json(JSON.parse(item.payload))},${item.manifest.count},${item.manifest.sha256})`;
  }
  await redis.set(
    activeDataPublicationKey({ dataset: 'fpl:price-changes', seasonCode: season.seasonCode }),
    JSON.stringify(prepared.manifest),
  );
  await Promise.all(prepared.items.map((item) => redis.set(item.manifest.key, item.payload)));
});
afterAll(async () => {
  await redis.del(
    activeDataPublicationKey({ dataset: 'fpl:price-changes', seasonCode: season.seasonCode }),
  );
  await Promise.all(prepared.items.map((item) => redis.del(item.manifest.key)));
  redis.disconnect();
  await db`DELETE FROM ops.dataset_publications WHERE publication_id=${publicationId}`;
  await db`DELETE FROM fpl.seasons WHERE season_id=2093`;
  await databaseSingleton.disconnect();
  await db.end();
});
test('returns context only and discovers deadlines without Redis or season discovery', async () => {
  const result = await loadActivePriceChangeContext(season);
  expect(Object.keys(result!.items)).toEqual(['context']);
  expect(JSON.stringify(result).length).toBeLessThan(2000);
  expect(await getPriceChangeWatchDeadlines(season, now)).toEqual({
    status: 'READY',
    nextDeadlines: context.nextDeadlines,
  });
  expect(await loadActivePriceChangeContext({ ...season, seasonCode: '9495' })).toBeNull();
});

test('falls back to durable context when the active Redis publication is unavailable', async () => {
  await redis.del(
    activeDataPublicationKey({ dataset: 'fpl:price-changes', seasonCode: season.seasonCode }),
    ...prepared.items.map((item) => item.manifest.key),
  );

  const identity = spyOn(
    syncOperationsRepository,
    'findActivePublicationManifest',
  ).mockRejectedValue(new Error('identity query must not run after a Redis failure'));
  try {
    await expect(getPriceChangeWatchDeadlines(season, now)).resolves.toEqual({
      status: 'READY',
      nextDeadlines: context.nextDeadlines,
    });
    expect(identity).not.toHaveBeenCalled();
  } finally {
    identity.mockRestore();
  }
});

test('rejects extra durable publication items outside the manifest', async () => {
  const payload = '{}';
  await db`INSERT INTO ops.dataset_publication_items
    (publication_id, item_name, payload, item_count, checksum)
    VALUES (
      ${publicationId},
      'eventLive',
      ${db.json({})},
      0,
      ${createHash('sha256').update(payload, 'utf8').digest('hex')}
    )`;

  expect(await loadActivePriceChangeContext(season)).toBeNull();
});

test('falls back to the canonical revision when Redis still points at the previous one', async () => {
  const newerContext = {
    ...context,
    deadline: '2093-08-22T02:30:00.000Z',
    nextDeadlines: ['2093-08-22T02:30:00.000Z'],
  };
  const newer = prepareDataPublication({
    ...season,
    dataset: 'fpl:price-changes',
    revision: 9395,
    publicationId,
    sourceCheckedAt: now,
    state: 'active',
    items: [
      { name: 'context', value: newerContext },
      { name: 'players', value: [{ unused: 'x'.repeat(400000) }] },
    ],
  });
  await db`UPDATE ops.dataset_publications SET revision=9395, manifest=${db.json(newer.manifest as never)} WHERE publication_id=${publicationId}`;
  await db`DELETE FROM ops.dataset_publication_items WHERE publication_id=${publicationId}`;
  for (const item of newer.items) {
    await db`INSERT INTO ops.dataset_publication_items (publication_id,item_name,payload,item_count,checksum)
      VALUES (${publicationId},${item.manifest.name},${db.json(JSON.parse(item.payload))},${item.manifest.count},${item.manifest.sha256})`;
  }

  await expect(getPriceChangeWatchDeadlines(season, now)).resolves.toEqual({
    status: 'READY',
    nextDeadlines: newerContext.nextDeadlines,
  });
});

test('falls back when a Redis publication sibling is missing', async () => {
  const playersKey = prepared.items.find((item) => item.manifest.name === 'players')!.manifest.key;
  await redis.del(playersKey);

  await expect(getPriceChangeWatchDeadlines(season, now)).resolves.toEqual({
    status: 'READY',
    nextDeadlines: context.nextDeadlines,
  });
});

test('does not reload durable players after a canonical Redis context is unusable', async () => {
  const invalidContext = { ...context, unexpected: true };
  const invalid = prepareDataPublication({
    ...season,
    dataset: 'fpl:price-changes',
    revision: prepared.manifest.revision,
    publicationId,
    sourceCheckedAt: now,
    state: 'active',
    items: [
      { name: 'context', value: invalidContext },
      { name: 'players', value: [{ unused: 'x'.repeat(400000) }] },
    ],
  });
  await redis.set(
    activeDataPublicationKey({ dataset: 'fpl:price-changes', seasonCode: season.seasonCode }),
    JSON.stringify(invalid.manifest),
  );
  await Promise.all(invalid.items.map((item) => redis.set(item.manifest.key, item.payload)));

  expect(await getPriceChangeWatchDeadlines(season, now)).toBeNull();
});

test('rejects a Redis pointer whose manifest identity disagrees with database columns', async () => {
  const foreignPublicationId = '00000000-0000-4000-8000-000000009395';
  const invalidManifest = { ...prepared.manifest, publicationId: foreignPublicationId };
  await db`UPDATE ops.dataset_publications SET manifest=${db.json(invalidManifest as never)}
    WHERE publication_id=${publicationId}`;
  await redis.set(
    activeDataPublicationKey({ dataset: 'fpl:price-changes', seasonCode: season.seasonCode }),
    JSON.stringify(invalidManifest),
  );

  expect(await getPriceChangeWatchDeadlines(season, now)).toBeNull();
});

test('does not accept a missing or retired active context', async () => {
  await db`UPDATE ops.dataset_publications SET status='retired', retired_at=now() WHERE publication_id=${publicationId}`;
  expect(await loadActivePriceChangeContext(season)).toBeNull();
  await db`UPDATE ops.dataset_publications SET status='active', retired_at=null WHERE publication_id=${publicationId}`;
  await db`DELETE FROM ops.dataset_publication_items WHERE publication_id=${publicationId} AND item_name='context'`;
  expect(await loadActivePriceChangeContext(season)).toBeNull();
});
test.each(['payload', 'checksum', 'count', 'payload-count', 'bytes', 'identity', 'revision'])(
  'rejects corrupted %s',
  async (field) => {
    if (field === 'payload')
      await db`UPDATE ops.dataset_publication_items SET payload=jsonb_set(payload,'{deadline}','"2093-08-22T02:00:00Z"') WHERE publication_id=${publicationId} AND item_name='context'`;
    if (field === 'checksum')
      await db`UPDATE ops.dataset_publication_items SET checksum=repeat('0',64) WHERE publication_id=${publicationId} AND item_name='context'`;
    if (field === 'count')
      await db`UPDATE ops.dataset_publication_items SET item_count=11 WHERE publication_id=${publicationId} AND item_name='context'`;
    if (field === 'payload-count') {
      const changed = prepareDataPublication({
        ...season,
        dataset: 'fpl:price-changes',
        revision: 9394,
        publicationId,
        sourceCheckedAt: now,
        state: 'active',
        items: [
          { name: 'context', value: { ...context, unexpected: true } },
          { name: 'players', value: [{ unused: 'x'.repeat(400000) }] },
        ],
      });
      const contextCount = prepared.manifest.items.find((item) => item.name === 'context')!.count;
      const manifest = {
        ...changed.manifest,
        items: changed.manifest.items.map((item) =>
          item.name === 'context' ? { ...item, count: contextCount } : item,
        ),
      };
      const contextItem = changed.items.find((item) => item.manifest.name === 'context')!;
      await db`UPDATE ops.dataset_publications SET manifest=${db.json(manifest as never)} WHERE publication_id=${publicationId}`;
      await db`UPDATE ops.dataset_publication_items
        SET payload=${db.json(JSON.parse(contextItem.payload))}, item_count=${contextCount}, checksum=${contextItem.manifest.sha256}
        WHERE publication_id=${publicationId} AND item_name='context'`;
    }
    if (field === 'bytes') {
      const manifest = structuredClone(prepared.manifest);
      const changed = {
        ...manifest,
        items: manifest.items.map((item) =>
          item.name === 'context' ? { ...item, bytes: item.bytes + 1 } : item,
        ),
      };
      await db`UPDATE ops.dataset_publications SET manifest=${db.json(changed as never)} WHERE publication_id=${publicationId}`;
    }
    if (field === 'identity')
      await db`UPDATE ops.dataset_publications SET manifest=jsonb_set(manifest,'{publicationId}','"00000000-0000-4000-8000-000000009395"') WHERE publication_id=${publicationId}`;
    if (field === 'revision')
      await db`UPDATE ops.dataset_publications SET revision=9395 WHERE publication_id=${publicationId}`;
    expect(await loadActivePriceChangeContext(season)).toBeNull();
  },
);
