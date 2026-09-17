import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  activeDataPublicationKey,
  clearDataPublicationIntegrityFailure,
  dataPublicationIntegrityProofKey,
  dataPublicationItemKey,
  hasDataPublicationIntegrityFailure,
  parseDataPublicationManifest,
  prepareDataPublication,
  readActiveDataPublication,
  readActiveDataPublicationItem,
  readActiveDataPublicationManifest,
  readActiveDataPublicationManifestWithItemBounds,
  readActiveDataPublicationItemsWithBounds,
  readActiveDataPublicationItems,
  type DataPublicationManifest,
} from '../../src/cache/data-publication';
import type Redis from 'ioredis';

const scope = { dataset: 'fpl:core' as const, seasonCode: '2627' };
const payload = JSON.stringify([{ id: 1 }]);

function validManifest(): DataPublicationManifest {
  return {
    dataset: 'fpl:core',
    seasonCode: '2627',
    eventId: null,
    revision: 7,
    publicationId: '00000000-0000-4000-8000-000000000007',
    sourceCheckedAt: '2026-08-09T01:00:00.000Z',
    publishedAt: '2026-08-09T01:00:01.000Z',
    state: 'active',
    items: ['events', 'teams', 'players', 'phases', 'fixtures', 'currentEventId'].map((name) => ({
      name,
      key: dataPublicationItemKey(scope, 7, name),
      type: 'string',
      count: 1,
      bytes: Buffer.byteLength(payload, 'utf8'),
      sha256: createHash('sha256').update(payload).digest('hex'),
    })),
  };
}

describe('data publication contract', () => {
  test('builds canonical generic publication keys', () => {
    expect(activeDataPublicationKey(scope)).toBe('llm:data:fpl:core:2627:active');
    expect(dataPublicationItemKey(scope, 7, 'currentEventId')).toBe(
      'llm:data:fpl:core:2627:7:currentEventId',
    );
    expect(activeDataPublicationKey({ dataset: 'fpl:price-changes', seasonCode: '2627' })).toBe(
      'llm:data:fpl:price-changes:2627:active',
    );
  });

  test('rejects invalid scope, revision, and item identity', () => {
    expect(() => activeDataPublicationKey({ dataset: 'fpl:core', seasonCode: '26/27' })).toThrow();
    expect(() =>
      activeDataPublicationKey({ dataset: 'fpl:core', seasonCode: '2627', eventId: 12 }),
    ).toThrow();
    expect(() => dataPublicationItemKey(scope, 0, 'events')).toThrow();
    expect(() => dataPublicationItemKey(scope, 1, 'events:old')).toThrow();
  });

  test('accepts an exact canonical manifest', () => {
    const manifest = validManifest();
    expect(parseDataPublicationManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  test('accepts the exact context and players item set for price changes', () => {
    const priceScope = { dataset: 'fpl:price-changes' as const, seasonCode: '2627' };
    const manifest: DataPublicationManifest = {
      dataset: 'fpl:price-changes',
      seasonCode: '2627',
      eventId: null,
      revision: 8,
      publicationId: '00000000-0000-4000-8000-000000000008',
      sourceCheckedAt: '2026-08-09T01:00:00.000Z',
      publishedAt: '2026-08-09T01:00:01.000Z',
      state: 'active',
      items: ['context', 'players'].map((name) => ({
        name,
        key: dataPublicationItemKey(priceScope, 8, name),
        type: 'string',
        count: 1,
        bytes: Buffer.byteLength(payload, 'utf8'),
        sha256: createHash('sha256').update(payload).digest('hex'),
      })),
    };
    expect(parseDataPublicationManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(
      parseDataPublicationManifest(JSON.stringify({ ...manifest, items: [manifest.items[0]] })),
    ).toBeNull();
  });

  test('accepts the optional successful-fetch heartbeat without changing revision identity', () => {
    const manifest = {
      ...validManifest(),
      lastSuccessfulFetchAt: '2026-08-09T01:00:02.000Z',
    };
    expect(parseDataPublicationManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(
      parseDataPublicationManifest(
        JSON.stringify({ ...manifest, lastSuccessfulFetchAt: 'not-a-date' }),
      ),
    ).toBeNull();
  });

  test('preserves all joined freshness windows in a price publication manifest', () => {
    const priceScope = { dataset: 'fpl:price-changes' as const, seasonCode: '2627' };
    const manifest: DataPublicationManifest = {
      dataset: 'fpl:price-changes',
      seasonCode: '2627',
      eventId: null,
      revision: 9,
      publicationId: '00000000-0000-4000-8000-000000000009',
      sourceCheckedAt: '2026-08-09T01:00:00.000Z',
      freshnessWindowId: 17,
      freshnessWindowIds: [17, 18],
      publishedAt: '2026-08-09T01:00:01.000Z',
      state: 'active',
      items: ['context', 'players'].map((name) => ({
        name,
        key: dataPublicationItemKey(priceScope, 9, name),
        type: 'string',
        count: 1,
        bytes: Buffer.byteLength(payload, 'utf8'),
        sha256: createHash('sha256').update(payload).digest('hex'),
      })),
    };
    expect(parseDataPublicationManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(
      parseDataPublicationManifest(JSON.stringify({ ...manifest, freshnessWindowIds: [0] })),
    ).toBeNull();
  });

  test('rejects malformed IDs, duplicate names, and noncanonical item keys', () => {
    const manifest = validManifest();
    expect(
      parseDataPublicationManifest(
        JSON.stringify({ ...manifest, publicationId: 'not-a-publication-id' }),
      ),
    ).toBeNull();
    expect(
      parseDataPublicationManifest(
        JSON.stringify({
          ...manifest,
          items: [manifest.items[0], { ...manifest.items[0] }],
        }),
      ),
    ).toBeNull();
    expect(
      parseDataPublicationManifest(
        JSON.stringify({
          ...manifest,
          items: [{ ...manifest.items[0], key: `${manifest.items[0].key}:foreign` }],
        }),
      ),
    ).toBeNull();
  });

  test('rejects additional manifest fields', () => {
    const manifest = validManifest();
    expect(
      parseDataPublicationManifest(JSON.stringify({ ...manifest, extraField: true })),
    ).toBeNull();
  });

  test('rejects a generic manifest carrying an event', () => {
    const manifest = validManifest();
    expect(parseDataPublicationManifest(JSON.stringify({ ...manifest, eventId: 1 }))).toBeNull();
  });

  test('returns selected active publication items after validating every sibling', async () => {
    const priceScope = { dataset: 'fpl:price-changes' as const, seasonCode: '2627' };
    const prepared = prepareDataPublication({
      ...priceScope,
      revision: 11,
      publicationId: '00000000-0000-4000-8000-000000000011',
      sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
      state: 'active',
      items: [
        { name: 'context', value: { deadline: '2026-08-09T02:00:00.000Z' } },
        { name: 'players', value: [{ id: 1 }] },
      ],
    });
    const values = new Map<string, string>([
      [activeDataPublicationKey(priceScope), JSON.stringify(prepared.manifest)],
      [
        dataPublicationIntegrityProofKey(priceScope),
        `${prepared.manifest.publicationId}:${prepared.manifest.revision}`,
      ],
      ...prepared.items.map((item) => [item.manifest.key, item.payload] as const),
    ]);
    const requested: string[] = [];
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
      mget: async (...keys: string[]) => {
        requested.push(...keys);
        return keys.map((key) => values.get(key) ?? null);
      },
    } as unknown as Redis;

    await expect(readActiveDataPublicationItems(priceScope, ['context'], redis)).resolves.toEqual({
      manifest: prepared.manifest,
      items: { context: { deadline: '2026-08-09T02:00:00.000Z' } },
    });
    expect(requested).toEqual([
      dataPublicationItemKey(priceScope, 11, 'context'),
      dataPublicationItemKey(priceScope, 11, 'players'),
    ]);

    values.delete(dataPublicationItemKey(priceScope, 11, 'players'));
    await expect(
      readActiveDataPublicationItems(priceScope, ['context'], redis),
    ).resolves.toBeNull();
  });

  test('control reads fetch only the manifest or selected item', async () => {
    const priceScope = { dataset: 'fpl:price-changes' as const, seasonCode: '2627' };
    const prepared = prepareDataPublication({
      ...priceScope,
      revision: 12,
      publicationId: '00000000-0000-4000-8000-000000000012',
      sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
      state: 'active',
      items: [
        { name: 'context', value: { deadline: '2026-08-09T02:00:00.000Z' } },
        { name: 'players', value: [{ id: 1 }, { id: 2 }] },
      ],
    });
    const values = new Map<string, string>([
      [activeDataPublicationKey(priceScope), JSON.stringify(prepared.manifest)],
      ...prepared.items.map((item) => [item.manifest.key, item.payload] as const),
    ]);
    const gets: string[] = [];
    const redis = {
      get: async (key: string) => {
        gets.push(key);
        return values.get(key) ?? null;
      },
    } as unknown as Redis;

    await expect(readActiveDataPublicationManifest(priceScope, redis)).resolves.toEqual(
      prepared.manifest,
    );
    expect(gets).toEqual([activeDataPublicationKey(priceScope)]);
    gets.length = 0;
    await expect(readActiveDataPublicationItem(priceScope, 'context', redis)).resolves.toEqual({
      manifest: prepared.manifest,
      items: { context: { deadline: '2026-08-09T02:00:00.000Z' } },
    });
    expect(gets).toEqual([
      activeDataPublicationKey(priceScope),
      dataPublicationItemKey(priceScope, 12, 'context'),
    ]);
  });

  test('reconciliation checks Redis item presence and size without downloading payloads', async () => {
    const priceScope = { dataset: 'fpl:price-changes' as const, seasonCode: '2627' };
    const prepared = prepareDataPublication({
      ...priceScope,
      revision: 12,
      publicationId: '00000000-0000-4000-8000-000000000012',
      sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
      state: 'active',
      items: [
        { name: 'context', value: { deadline: '2026-08-09T02:00:00.000Z' } },
        { name: 'players', value: [{ id: 1 }, { id: 2 }] },
      ],
    });
    const values = new Map<string, string>([
      [activeDataPublicationKey(priceScope), JSON.stringify(prepared.manifest)],
    ]);
    const commands: string[] = [];
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
      pipeline: () => {
        const pipeline = {
          exists: (key: string) => {
            commands.push(`exists:${key}`);
            return pipeline;
          },
          strlen: (key: string) => {
            commands.push(`strlen:${key}`);
            return pipeline;
          },
          exec: async () =>
            prepared.manifest.items.flatMap((item) => [
              [null, 1],
              [null, item.bytes],
            ]),
        };
        return pipeline;
      },
    } as unknown as Redis;

    await expect(
      readActiveDataPublicationManifestWithItemBounds(priceScope, redis),
    ).resolves.toEqual(prepared.manifest);
    expect(commands).toEqual(
      prepared.manifest.items.flatMap((item) => [`exists:${item.key}`, `strlen:${item.key}`]),
    );
    expect(values.has(dataPublicationItemKey(priceScope, 12, 'players'))).toBe(false);
  });

  test('bounded selected reads validate siblings but fetch only requested payloads', async () => {
    const priceScope = { dataset: 'fpl:price-changes' as const, seasonCode: '2627' };
    const prepared = prepareDataPublication({
      ...priceScope,
      revision: 13,
      publicationId: '00000000-0000-4000-8000-000000000013',
      sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
      state: 'active',
      items: [
        { name: 'context', value: { deadline: '2026-08-09T02:00:00.000Z' } },
        { name: 'players', value: [{ id: 1 }, { id: 2 }] },
      ],
    });
    const values = new Map<string, string>([
      [activeDataPublicationKey(priceScope), JSON.stringify(prepared.manifest)],
      [
        dataPublicationIntegrityProofKey(priceScope),
        `${prepared.manifest.publicationId}:${prepared.manifest.revision}`,
      ],
      ...prepared.items.map((item) => [item.manifest.key, item.payload] as const),
    ]);
    const requested: string[] = [];
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
      mget: async (...keys: string[]) => {
        requested.push(...keys);
        return keys.map((key) => values.get(key) ?? null);
      },
      pipeline: () => {
        const pipeline = {
          exists: () => pipeline,
          strlen: () => pipeline,
          exec: async () =>
            prepared.manifest.items.flatMap((item) => [
              [null, 1],
              [null, item.bytes],
            ]),
        };
        return pipeline;
      },
    } as unknown as Redis;

    await expect(
      readActiveDataPublicationItemsWithBounds(priceScope, ['context'], redis),
    ).resolves.toMatchObject({
      manifest: prepared.manifest,
      items: { context: { deadline: '2026-08-09T02:00:00.000Z' } },
    });
    expect(requested).toEqual([dataPublicationItemKey(priceScope, 13, 'context')]);
  });

  test('bootstraps a full proof before accepting a selected item', async () => {
    const priceScope = { dataset: 'fpl:price-changes' as const, seasonCode: '2627' };
    const prepared = prepareDataPublication({
      ...priceScope,
      revision: 15,
      publicationId: '00000000-0000-4000-8000-000000000015',
      sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
      state: 'active',
      items: [
        { name: 'context', value: { deadline: '2026-08-09T02:00:00.000Z' } },
        { name: 'players', value: [{ id: 1 }] },
      ],
    });
    const corruptedPlayers = JSON.stringify([{ id: 2 }]);
    const values = new Map<string, string>([
      [activeDataPublicationKey(priceScope), JSON.stringify(prepared.manifest)],
      [prepared.items[0]!.manifest.key, prepared.items[0]!.payload],
      [prepared.items[1]!.manifest.key, corruptedPlayers],
    ]);
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
      mget: async (...keys: string[]) => keys.map((key) => values.get(key) ?? null),
      pipeline: () => {
        const pipeline = {
          exists: () => pipeline,
          strlen: () => pipeline,
          exec: async () =>
            prepared.manifest.items.flatMap((item) => [
              [null, 1],
              [null, item.bytes],
            ]),
        };
        return pipeline;
      },
    } as unknown as Redis;

    await expect(
      readActiveDataPublicationItemsWithBounds(priceScope, ['context'], redis),
    ).resolves.toBeNull();
  });

  test('full integrity reads flag same-sized corruption for targeted repair', async () => {
    const priceScope = { dataset: 'fpl:price-changes' as const, seasonCode: '2627' };
    const prepared = prepareDataPublication({
      ...priceScope,
      revision: 14,
      publicationId: '00000000-0000-4000-8000-000000000014',
      sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
      state: 'active',
      items: [
        { name: 'context', value: { value: 1 } },
        { name: 'players', value: [{ id: 1 }] },
      ],
    });
    const values = new Map<string, string>([
      [activeDataPublicationKey(priceScope), JSON.stringify(prepared.manifest)],
      ...prepared.items.map((item) => [item.manifest.key, item.payload] as const),
    ]);
    const contextKey = dataPublicationItemKey(priceScope, 14, 'context');
    const originalContext = values.get(contextKey)!;
    values.set(contextKey, JSON.stringify({ value: 2 }));
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
      mget: async (...keys: string[]) => keys.map((key) => values.get(key) ?? null),
    } as unknown as Redis;

    await clearDataPublicationIntegrityFailure(priceScope, redis);
    await expect(readActiveDataPublication(priceScope, redis)).resolves.toBeNull();
    await expect(
      hasDataPublicationIntegrityFailure(priceScope, prepared.manifest, redis),
    ).resolves.toBe(true);

    values.set(contextKey, originalContext);
    await expect(readActiveDataPublication(priceScope, redis)).resolves.toMatchObject({
      manifest: prepared.manifest,
    });
    await expect(
      hasDataPublicationIntegrityFailure(priceScope, prepared.manifest, redis),
    ).resolves.toBe(false);
  });
});
