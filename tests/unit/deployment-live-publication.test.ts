import { describe, expect, test } from 'bun:test';

import {
  assertImmutableLiveManifestMatch,
  assertRetiredLiveManifestMatch,
} from '../../src/services/deployment-live-publication.service';
import type { DataPublicationManifest } from '../../src/cache/data-publication';

const baseManifest: DataPublicationManifest = {
  dataset: 'fpl:live',
  seasonCode: '2627',
  eventId: 3,
  revision: 41,
  publicationId: '11111111-1111-4111-8111-111111111111',
  sourceCheckedAt: '2026-08-10T23:00:00.000Z',
  publishedAt: '2026-08-10T23:00:01.000Z',
  state: 'live',
  items: [
    {
      name: 'eventLives',
      key: 'llm:data:fpl:live:2627:3:41:eventLives',
      type: 'string',
      count: 1,
      bytes: 42,
      sha256: 'a'.repeat(64),
    },
  ],
};

describe('deployment live publication manifest fence', () => {
  test('allows timestamp changes during retry recovery', () => {
    expect(() =>
      assertImmutableLiveManifestMatch(baseManifest, {
        ...baseManifest,
        sourceCheckedAt: '2026-08-10T23:01:00.000Z',
        publishedAt: '2026-08-10T23:01:01.000Z',
      }),
    ).not.toThrow();
  });

  test('rejects item descriptor drift before PostgreSQL is overwritten', () => {
    expect(() =>
      assertImmutableLiveManifestMatch(baseManifest, {
        ...baseManifest,
        items: [{ ...baseManifest.items[0], sha256: 'b'.repeat(64) }],
      }),
    ).toThrow('differs from PostgreSQL publication');
  });

  test('rejects identity drift even when item descriptors match', () => {
    expect(() =>
      assertImmutableLiveManifestMatch(baseManifest, {
        ...baseManifest,
        revision: 42,
      }),
    ).toThrow('differs from PostgreSQL publication');
  });

  test('normalizes retired item namespaces before comparing immutable descriptors', () => {
    const retiredManifest = {
      ...baseManifest,
      sourceCheckedAt: '2026-08-10T22:00:00.000Z',
      publishedAt: '2026-08-10T22:00:01.000Z',
      items: [
        {
          ...baseManifest.items[0],
          key: 'llm:v3:data:fpl:live:2627:3:41:eventLives',
        },
      ],
    };
    expect(() => assertRetiredLiveManifestMatch(baseManifest, retiredManifest)).not.toThrow();
    expect(() =>
      assertRetiredLiveManifestMatch(baseManifest, {
        ...retiredManifest,
        items: [{ ...retiredManifest.items[0], count: 2 }],
      }),
    ).toThrow('differs from PostgreSQL publication');
  });
});
