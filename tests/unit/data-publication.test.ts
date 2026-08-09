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
    schemaVersion: 'v3',
    planVersion: '3.2.5',
    dataset: 'fpl:core',
    seasonCode: '2627',
    eventId: null,
    revision: 7,
    publicationId: '00000000-0000-4000-8000-000000000007',
    sourceCheckedAt: '2026-08-09T01:00:00.000Z',
    publishedAt: '2026-08-09T01:00:01.000Z',
    items: [
      {
        name: 'events',
        key: dataPublicationItemKey(scope, 7, 'events'),
        type: 'string',
        count: 1,
        bytes: Buffer.byteLength(payload, 'utf8'),
        sha256: createHash('sha256').update(payload).digest('hex'),
      },
    ],
  };
}

describe('v3 data publication contract', () => {
  test('builds only canonical core and live keys', () => {
    expect(activeDataPublicationKey(scope)).toBe('llm:v3:data:fpl:core:2627:active');
    expect(dataPublicationItemKey(scope, 7, 'currentEventId')).toBe(
      'llm:v3:data:fpl:core:2627:7:currentEventId',
    );
    expect(activeDataPublicationKey({ dataset: 'fpl:live', seasonCode: '2627', eventId: 12 })).toBe(
      'llm:v3:data:fpl:live:2627:12:active',
    );
  });

  test('rejects invalid scope, revision, and item identity', () => {
    expect(() => activeDataPublicationKey({ dataset: 'fpl:core', seasonCode: '26/27' })).toThrow();
    expect(() => activeDataPublicationKey({ dataset: 'fpl:live', seasonCode: '2627' })).toThrow();
    expect(() => dataPublicationItemKey(scope, 0, 'events')).toThrow();
    expect(() => dataPublicationItemKey(scope, 1, 'events:v2')).toThrow();
  });

  test('accepts an exact canonical manifest', () => {
    const manifest = validManifest();
    expect(parseDataPublicationManifest(JSON.stringify(manifest))).toEqual(manifest);
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

  test('rejects a manifest from another Data Platform plan version', () => {
    const manifest = validManifest();
    expect(
      parseDataPublicationManifest(JSON.stringify({ ...manifest, planVersion: '3.2.3' })),
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
