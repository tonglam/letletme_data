import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  activeDataPublicationKey,
  clearDataPublicationIntegrityFailure,
  dataPublicationIntegrityProofToken,
  dataPublicationIntegrityProofKey,
  dataPublicationItemKey,
  hasDataPublicationIntegrityFailure,
  hasDataPublicationIntegrityProof,
  markDataPublicationIntegrityProof,
  markDataPublicationIntegrityFailure,
  parseDataPublicationManifest,
  prepareDataPublication,
  readActiveDataPublication,
  readActiveDataPublicationItem,
  readActiveDataPublicationManifest,
  readActiveDataPublicationManifestWithItemBounds,
  readActiveDataPublicationManifestWithItemBoundsStatus,
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
        dataPublicationIntegrityProofToken(prepared.manifest),
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

  test('fences an audited payload read to the complete captured manifest', async () => {
    const captured = validManifest();
    const rewritten = {
      ...captured,
      items: captured.items.map((item, index) =>
        index === 0 ? { ...item, bytes: item.bytes + 1 } : item,
      ),
    };
    const mget = async () => {
      throw new Error('payload read must not start after the manifest fence changes');
    };
    const redis = {
      get: async (key: string) =>
        key === activeDataPublicationKey(scope) ? JSON.stringify(rewritten) : null,
      mget,
    } as unknown as Redis;

    await expect(readActiveDataPublication(scope, redis, undefined, captured)).resolves.toBeNull();
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

  test('distinguishes a missing active pointer from an invalid publication', async () => {
    const priceScope = { dataset: 'fpl:price-changes' as const, seasonCode: '2627' };
    const prepared = prepareDataPublication({
      ...priceScope,
      revision: 14,
      publicationId: '00000000-0000-4000-8000-000000000014',
      sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
      state: 'active',
      items: [
        { name: 'context', value: { deadline: '2026-08-09T02:00:00.000Z' } },
        { name: 'players', value: [{ id: 1 }] },
      ],
    });
    const values = new Map<string, string>([
      [activeDataPublicationKey(priceScope), JSON.stringify(prepared.manifest)],
      ...prepared.items.map((item) => [item.manifest.key, item.payload] as const),
    ]);
    let pointerType = 'string';
    let invalidItems = false;
    const redis = {
      type: async () => pointerType,
      get: async (key: string) => values.get(key) ?? null,
      pipeline: () => {
        const pipeline = {
          exists: () => pipeline,
          strlen: () => pipeline,
          exec: async () =>
            prepared.manifest.items.flatMap((item) => [
              [null, invalidItems ? 0 : 1],
              [null, item.bytes],
            ]),
        };
        return pipeline;
      },
    } as unknown as Redis;

    await expect(
      readActiveDataPublicationManifestWithItemBoundsStatus(priceScope, redis),
    ).resolves.toEqual({ status: 'valid', manifest: prepared.manifest });

    invalidItems = true;
    await expect(
      readActiveDataPublicationManifestWithItemBoundsStatus(priceScope, redis),
    ).resolves.toEqual({ status: 'invalid', manifest: null });

    pointerType = 'hash';
    await expect(
      readActiveDataPublicationManifestWithItemBoundsStatus(priceScope, redis),
    ).resolves.toEqual({ status: 'invalid', manifest: null });

    pointerType = 'none';
    await expect(
      readActiveDataPublicationManifestWithItemBoundsStatus(priceScope, redis),
    ).resolves.toEqual({ status: 'missing', manifest: null });
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
        dataPublicationIntegrityProofToken(prepared.manifest),
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
    ).resolves.toBe(true);

    // A later ordinary proof cannot erase same-revision corruption evidence;
    // only the explicit repair boundary may clear that marker.
    await clearDataPublicationIntegrityFailure(priceScope, redis, prepared.manifest);
    await expect(
      hasDataPublicationIntegrityFailure(priceScope, prepared.manifest, redis),
    ).resolves.toBe(false);
  });

  test('keeps local integrity failures isolated by publication identity', async () => {
    const identityScope = { dataset: 'fpl:core' as const, seasonCode: '9797' };
    const items = [
      { name: 'events', value: [] },
      { name: 'teams', value: [] },
      { name: 'players', value: [] },
      { name: 'phases', value: [] },
      { name: 'fixtures', value: [] },
      { name: 'currentEventId', value: null },
      { name: 'selectionRules', value: null },
    ];
    const first = prepareDataPublication({
      ...identityScope,
      revision: 1,
      publicationId: '00000000-0000-4000-8000-000000000101',
      sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
      state: 'active',
      items,
    });
    const second = prepareDataPublication({
      ...identityScope,
      revision: 2,
      publicationId: '00000000-0000-4000-8000-000000000102',
      sourceCheckedAt: new Date('2026-08-09T01:00:01.000Z'),
      state: 'active',
      items,
    });
    const redis = {
      del: async () => 1,
      eval: async () => 1,
      get: async () => null,
    } as unknown as Redis;

    await markDataPublicationIntegrityFailure(identityScope, first.manifest, redis);
    await markDataPublicationIntegrityFailure(identityScope, second.manifest, redis);

    await expect(
      hasDataPublicationIntegrityFailure(identityScope, second.manifest, redis),
    ).resolves.toBe(true);
    await clearDataPublicationIntegrityFailure(identityScope, redis);
  });

  test('does not let an older proof clear a fresh local integrity failure', async () => {
    const proofScope = { dataset: 'fpl:core' as const, seasonCode: '9798' };
    const prepared = prepareDataPublication({
      ...proofScope,
      revision: 1,
      publicationId: '00000000-0000-4000-8000-000000000103',
      sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
      state: 'active',
      items: [
        { name: 'events', value: [] },
        { name: 'teams', value: [] },
        { name: 'players', value: [] },
        { name: 'phases', value: [] },
        { name: 'fixtures', value: [] },
        { name: 'currentEventId', value: null },
        { name: 'selectionRules', value: null },
      ],
    });
    const token = dataPublicationIntegrityProofToken(prepared.manifest);
    const redis = {
      del: async () => 1,
      eval: async () => 1,
      get: async (key: string) =>
        key === dataPublicationIntegrityProofKey(proofScope) ? token : null,
    } as unknown as Redis;

    await markDataPublicationIntegrityFailure(proofScope, prepared.manifest, redis);

    await expect(
      hasDataPublicationIntegrityFailure(proofScope, prepared.manifest, redis),
    ).resolves.toBe(true);
    await clearDataPublicationIntegrityFailure(proofScope, redis);
  });

  test('does not reuse a proof when the complete manifest changes', async () => {
    const proofScope = { dataset: 'fpl:core' as const, seasonCode: '9997' };
    const manifest = { ...validManifest(), seasonCode: proofScope.seasonCode };
    const changedManifest = { ...manifest, sourceCheckedAt: '2026-08-10T01:00:00.000Z' };
    const values = new Map<string, string>([
      [dataPublicationIntegrityProofKey(proofScope), dataPublicationIntegrityProofToken(manifest)],
    ]);
    const redis = {
      get: async (key: string) => values.get(key) ?? null,
    } as unknown as Redis;

    await expect(hasDataPublicationIntegrityProof(proofScope, manifest, redis)).resolves.toBe(true);
    await expect(
      hasDataPublicationIntegrityProof(proofScope, changedManifest, redis),
    ).resolves.toBe(false);
  });

  test('does not look up a proof after a matching local failure is known', async () => {
    const localScope = { dataset: 'fpl:core' as const, seasonCode: '9898' };
    const manifest = { ...validManifest(), seasonCode: localScope.seasonCode };
    const gets: string[] = [];
    const redis = {
      get: async (key: string) => {
        gets.push(key);
        return null;
      },
      eval: async () => 1,
      del: async () => 1,
    } as unknown as Redis;

    await markDataPublicationIntegrityFailure(localScope, manifest, redis);
    await expect(hasDataPublicationIntegrityFailure(localScope, manifest, redis)).resolves.toBe(
      true,
    );
    expect(gets).toHaveLength(1);
    expect(gets[0]).not.toBe(dataPublicationIntegrityProofKey(localScope));
    await clearDataPublicationIntegrityFailure(localScope, redis);
  });

  test('coalesces fire-and-forget proof refreshes for one publication', async () => {
    const proofScope = { dataset: 'fpl:core' as const, seasonCode: '9899' };
    const manifest = { ...validManifest(), seasonCode: proofScope.seasonCode };
    const calls: unknown[][] = [];
    const redis = {
      eval: async (...args: unknown[]) => {
        calls.push(args);
        return 1;
      },
    } as unknown as Redis;

    await markDataPublicationIntegrityProof(manifest, redis, { fireAndForget: true });
    await markDataPublicationIntegrityProof(manifest, redis, { fireAndForget: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(1);
  });

  test('fails closed when the shared integrity marker cannot be read', async () => {
    const unreadableScope = scope;
    const cleanupRedis = { del: async () => 1 } as unknown as Redis;
    await clearDataPublicationIntegrityFailure(unreadableScope, cleanupRedis);

    const redis = {
      get: async () => {
        throw new Error('integrity marker unavailable');
      },
    } as unknown as Redis;

    await expect(
      hasDataPublicationIntegrityFailure(unreadableScope, validManifest(), redis),
    ).resolves.toBe(true);
  });
});
