import { describe, expect, test } from 'bun:test';

import {
  acquisitionBatchV1Schema,
  canonicalAcquisitionItem,
  canonicalizePublicUrl,
  type AcquisitionItemV1,
} from '../../../src/content/acquisition/acquisition-contract';

const item = (overrides: Partial<AcquisitionItemV1> = {}): AcquisitionItemV1 => ({
  endpointKey: 'fpl-focal-youtube',
  externalItemId: 'Xef37ImWz3M',
  canonicalUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M&utm_source=test',
  sourceUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M&utm_source=test',
  linkAvailability: 'DIRECT',
  publishedAt: '2026-08-20T10:00:00.000Z',
  updatedAt: null,
  title: '  FPL\u2003Focal  ',
  authorExternalId: 'UC72QokPHXQ9r98ROfNZmaDw',
  contentKind: 'VIDEO',
  body: { availability: 'METADATA_ONLY', text: null },
  media: [],
  transcript: {
    status: 'PROVIDED',
    language: 'en',
    trackKind: 'UNKNOWN',
    providerRevision: 'supadata-native-v1',
    segments: [{ startMs: 0, endMs: 1_000, text: ' hello\n world ' }],
  },
  ...overrides,
});

describe('AcquisitionBatchV1 contract', () => {
  test('normalizes item facts before hashing without removing unknown query parameters', () => {
    expect(canonicalizePublicUrl('https://Example.com/a?token=abc&utm_source=x&id=1#frag')).toBe(
      'https://example.com/a?token=abc&id=1',
    );
    const canonical = canonicalAcquisitionItem(item());
    expect(canonical.payload).toMatchObject({
      title: 'FPL Focal',
      canonicalUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M',
      transcript: { segments: [{ startMs: 0, endMs: 1_000, text: 'hello world' }] },
    });
    expect(canonical.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects non-terminal transcript success and inconsistent link availability', () => {
    const parsed = acquisitionBatchV1Schema.safeParse({
      schemaVersion: 1,
      endpointKey: 'fpl-focal-youtube',
      checkedAt: '2026-08-22T00:00:00.000Z',
      validator: {
        etag: null,
        lastModified: null,
        providerCursor: null,
        cacheNotBefore: null,
      },
      transportBodyHash: null,
      items: [
        item({
          canonicalUrl: null,
          sourceUrl: null,
          linkAvailability: 'DIRECT',
          transcript: {
            status: 'PROVIDED',
            language: 'en',
            trackKind: 'UNKNOWN',
            providerRevision: 'v1',
            segments: [],
          },
        }),
      ],
    });
    expect(parsed.success).toBe(false);
  });

  test('rejects conflicting duplicate external item facts as a whole batch', () => {
    const parsed = acquisitionBatchV1Schema.safeParse({
      schemaVersion: 1,
      endpointKey: 'fpl-focal-youtube',
      checkedAt: '2026-08-22T00:00:00.000Z',
      validator: {
        etag: null,
        lastModified: null,
        providerCursor: null,
        cacheNotBefore: null,
      },
      transportBodyHash: null,
      items: [item(), item({ title: 'Different title' })],
    });
    expect(parsed.success).toBe(false);
  });
});
