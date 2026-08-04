import { describe, expect, test } from 'bun:test';
import type Redis from 'ioredis';

import {
  liveSnapshotMetaKey,
  replaceHashesUnlessLiveSnapshotOwned,
} from '../../src/cache/live-snapshot-ownership';

describe('live snapshot cache ownership', () => {
  test('maps one atomic Redis status per guarded hash replacement', async () => {
    const calls: unknown[][] = [];
    const redis = {
      eval: async (...args: unknown[]) => {
        calls.push(args);
        return [0, 1];
      },
    } as unknown as Redis;

    const snapshotOwned = await replaceHashesUnlessLiveSnapshotOwned(redis, '2526', [
      { eventId: 10, key: 'Fixtures:2526:10', fields: { '100': 'old' } },
      { eventId: 11, key: 'Fixtures:2526:11', fields: {} },
    ]);

    expect(snapshotOwned).toEqual(new Set([10]));
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(1)).toEqual([
      4,
      'LiveSnapshotMeta:2526:10',
      'Fixtures:2526:10',
      'LiveSnapshotMeta:2526:11',
      'Fixtures:2526:11',
      '{"100":"old"}',
      '{}',
    ]);
  });

  test('does not call Redis for an empty replacement batch', async () => {
    let called = false;
    const redis = {
      eval: async () => {
        called = true;
        return [];
      },
    } as unknown as Redis;

    expect(await replaceHashesUnlessLiveSnapshotOwned(redis, '2526', [])).toEqual(new Set());
    expect(called).toBe(false);
  });

  test('rejects malformed ownership script results', async () => {
    const redis = { eval: async () => [2] } as unknown as Redis;
    await expect(
      replaceHashesUnlessLiveSnapshotOwned(redis, '2526', [
        { eventId: 10, key: 'Fixtures:2526:10', fields: {} },
      ]),
    ).rejects.toThrow('Unexpected snapshot ownership guard status');
  });

  test('builds the canonical metadata key', () => {
    expect(liveSnapshotMetaKey('2526', 10)).toBe('LiveSnapshotMeta:2526:10');
  });
});
