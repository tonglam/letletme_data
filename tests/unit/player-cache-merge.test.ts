import { describe, expect, test } from 'bun:test';

import { playersCache } from '../../src/cache/operations';
import { redisSingleton } from '../../src/cache/singleton';
import type { Player } from '../../src/types';

describe('players cache merge', () => {
  test('updates supplied fields without deleting unrelated players', async () => {
    const originalGetClient = redisSingleton.getClient;
    const fields = new Map<string, string>([
      ['1', JSON.stringify({ id: 1, webName: 'Untouched', price: 50 })],
      ['2', JSON.stringify({ id: 2, webName: 'Changed', price: 60 })],
    ]);
    let deleteCalls = 0;
    redisSingleton.getClient = async () =>
      ({
        hkeys: async () => Array.from(fields.keys()),
        hset: async (_key: string, entries: Record<string, string>) => {
          for (const [field, value] of Object.entries(entries)) fields.set(field, value);
          return Object.keys(entries).length;
        },
        del: async () => {
          deleteCalls += 1;
          return 1;
        },
      }) as never;

    const changed: Player = {
      id: 2,
      code: 1002,
      type: 3,
      teamId: 1,
      price: 61,
      startPrice: 60,
      firstName: 'Price',
      secondName: 'Change',
      webName: 'Changed',
    };
    try {
      await playersCache.merge([changed], [1, 2], '2627');
    } finally {
      redisSingleton.getClient = originalGetClient;
    }

    expect(JSON.parse(fields.get('1') ?? '{}')).toEqual({
      id: 1,
      webName: 'Untouched',
      price: 50,
    });
    expect(JSON.parse(fields.get('2') ?? '{}')).toEqual(changed);
    expect(deleteCalls).toBe(0);
  });

  test('refuses to create or extend an incomplete player view', async () => {
    const originalGetClient = redisSingleton.getClient;
    let hsetCalls = 0;
    redisSingleton.getClient = async () =>
      ({
        hkeys: async () => ['2'],
        hset: async () => {
          hsetCalls += 1;
          return 1;
        },
      }) as never;

    try {
      await expect(
        playersCache.merge(
          [
            {
              id: 2,
              code: 1002,
              type: 3,
              teamId: 1,
              price: 61,
              startPrice: 60,
              firstName: 'Price',
              secondName: 'Change',
              webName: 'Changed',
            },
          ],
          [1, 2],
          '2627',
        ),
      ).rejects.toThrow('Refusing to merge prices into incomplete players cache');
    } finally {
      redisSingleton.getClient = originalGetClient;
    }

    expect(hsetCalls).toBe(0);
  });
});
