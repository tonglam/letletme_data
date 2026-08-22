import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  activeDataPublicationKey,
  dataPublicationItemKey,
  parseDataPublicationManifest,
  type DataPublicationManifest,
} from '../../src/cache/data-publication';

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
  test('builds only canonical core and live keys', () => {
    expect(activeDataPublicationKey(scope)).toBe('llm:data:fpl:core:2627:active');
    expect(dataPublicationItemKey(scope, 7, 'currentEventId')).toBe(
      'llm:data:fpl:core:2627:7:currentEventId',
    );
    expect(activeDataPublicationKey({ dataset: 'fpl:live', seasonCode: '2627', eventId: 12 })).toBe(
      'llm:data:fpl:live:2627:12:active',
    );
  });

  test('rejects invalid scope, revision, and item identity', () => {
    expect(() => activeDataPublicationKey({ dataset: 'fpl:core', seasonCode: '26/27' })).toThrow();
    expect(() => activeDataPublicationKey({ dataset: 'fpl:live', seasonCode: '2627' })).toThrow();
    expect(() => dataPublicationItemKey(scope, 0, 'events')).toThrow();
    expect(() => dataPublicationItemKey(scope, 1, 'events:old')).toThrow();
  });

  test('accepts an exact canonical manifest', () => {
    const manifest = validManifest();
    expect(parseDataPublicationManifest(JSON.stringify(manifest))).toEqual(manifest);
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

  test('rejects a core manifest carrying an event and a live manifest without one', () => {
    const manifest = validManifest();
    expect(parseDataPublicationManifest(JSON.stringify({ ...manifest, eventId: 1 }))).toBeNull();
    expect(
      parseDataPublicationManifest(
        JSON.stringify({ ...manifest, dataset: 'fpl:live', eventId: null }),
      ),
    ).toBeNull();
  });
});
