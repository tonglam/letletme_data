import { describe, expect, test } from 'bun:test';

import {
  assertCoreCacheRebuildCandidate,
  decideCoreCacheDeployment,
} from '../../src/cache/core-cache-deployment';
import {
  dataPublicationItemKey,
  type DataPublicationManifest,
} from '../../src/cache/data-publication';

const scope = { dataset: 'fpl:core' as const, seasonCode: '2627' };

function manifest(overrides: Partial<DataPublicationManifest> = {}): DataPublicationManifest {
  return {
    dataset: 'fpl:core',
    seasonCode: '2627',
    eventId: null,
    revision: 2,
    publicationId: '00000000-0000-4000-8000-000000000002',
    sourceCheckedAt: '2026-08-10T03:47:40.141Z',
    publishedAt: '2026-08-12T10:28:43.300Z',
    state: 'active',
    items: ['events', 'teams', 'players', 'phases', 'fixtures', 'currentEventId'].map((name) => ({
      name,
      key: dataPublicationItemKey(scope, 2, name),
      type: 'string',
      count: 1,
      bytes: 2,
      sha256: '0'.repeat(64),
    })),
    ...overrides,
  };
}

describe('core cache deployment decision', () => {
  test('rebuilds only when no active cache is readable', () => {
    expect(decideCoreCacheDeployment(manifest(), null)).toBe('rebuild');
  });

  test('reuses an exact active canonical publication', () => {
    const canonical = manifest();
    expect(decideCoreCacheDeployment(canonical, structuredClone(canonical))).toBe('reuse');
  });

  test('rejects an active cache with the same revision but different content', () => {
    const canonical = manifest();
    const changedItems = canonical.items.map((item, index) =>
      index === 0 ? { ...item, sha256: '1'.repeat(64) } : item,
    );
    expect(() => decideCoreCacheDeployment(canonical, manifest({ items: changedItems }))).toThrow(
      'Active core cache does not match',
    );
  });

  test('allows a rebuild timestamp to change but rejects database snapshot drift', () => {
    const canonical = manifest();
    expect(() =>
      assertCoreCacheRebuildCandidate(
        canonical,
        manifest({ publishedAt: '2026-08-13T00:00:00.000Z' }),
      ),
    ).not.toThrow();

    const changedItems = canonical.items.map((item, index) =>
      index === 0 ? { ...item, bytes: item.bytes + 1 } : item,
    );
    expect(() =>
      assertCoreCacheRebuildCandidate(canonical, manifest({ items: changedItems })),
    ).toThrow('Current database snapshot does not match');
  });
});
