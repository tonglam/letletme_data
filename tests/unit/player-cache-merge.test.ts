import { describe, expect, test } from 'bun:test';

import { playersCache } from '../../src/cache/operations';
import { resetActiveSeasonMemo } from '../../src/cache/cache-season';
import { redisSingleton } from '../../src/cache/singleton';

describe('players cache merge', () => {
  test('replaces the complete roster in one Redis transaction', async () => {
    const originalGetClient = redisSingleton.getClient;
    const commands: string[] = [];
    let transactionExecutions = 0;
    const transaction = {
      del: (_key: string) => {
        commands.push('del');
        return transaction;
      },
      hset: (_key: string, _entries: Record<string, string>) => {
        commands.push('hset');
        return transaction;
      },
      exec: async () => {
        transactionExecutions += 1;
        return commands.map(() => [null, 1]);
      },
    };
    redisSingleton.getClient = async () =>
      ({
        multi: () => transaction,
        get: async () => '2526',
      }) as never;
    resetActiveSeasonMemo();

    try {
      await playersCache.set(
        [
          {
            id: 1,
            code: 1001,
            type: 3,
            teamId: 1,
            price: 60,
            startPrice: 60,
            firstName: 'Complete',
            secondName: 'Roster',
            webName: 'Complete',
          },
        ],
        '2526',
      );
    } finally {
      redisSingleton.getClient = originalGetClient;
      resetActiveSeasonMemo();
    }

    expect(commands).toEqual(['del', 'hset']);
    expect(transactionExecutions).toBe(1);
  });

  test('atomically patches only prices without overwriting current identity fields', async () => {
    const originalGetClient = redisSingleton.getClient;
    const fields = new Map<string, string>([
      ['1', JSON.stringify({ id: 1, webName: 'Untouched', price: 50 })],
      ['2', JSON.stringify({ id: 2, teamId: 9, webName: 'Current identity', price: 60 })],
    ]);
    let evalCalls = 0;
    redisSingleton.getClient = async () =>
      ({
        eval: async (
          _script: string,
          _keyCount: number,
          _key: string,
          expectedCount: string,
          updateCount: string,
          ...args: string[]
        ) => {
          evalCalls += 1;
          const expectedIds = args.slice(0, Number(expectedCount));
          if (
            fields.size !== Number(expectedCount) ||
            expectedIds.some((elementId) => !fields.has(elementId))
          ) {
            return -1;
          }
          const updateArgs = args.slice(Number(expectedCount));
          for (let index = 0; index < Number(updateCount); index += 1) {
            const elementId = updateArgs[index * 2];
            const price = Number(updateArgs[index * 2 + 1]);
            const current = JSON.parse(fields.get(elementId)!);
            fields.set(elementId, JSON.stringify({ ...current, price }));
          }
          return Number(updateCount);
        },
      }) as never;

    try {
      await playersCache.mergePrices([{ elementId: 2, value: 61 }], [1, 2], '2627');
    } finally {
      redisSingleton.getClient = originalGetClient;
    }

    expect(JSON.parse(fields.get('1') ?? '{}')).toEqual({
      id: 1,
      webName: 'Untouched',
      price: 50,
    });
    expect(JSON.parse(fields.get('2') ?? '{}')).toEqual({
      id: 2,
      teamId: 9,
      webName: 'Current identity',
      price: 61,
    });
    expect(evalCalls).toBe(1);
  });

  test('refuses to create or extend an incomplete player view', async () => {
    const originalGetClient = redisSingleton.getClient;
    let evalCalls = 0;
    redisSingleton.getClient = async () =>
      ({
        eval: async () => {
          evalCalls += 1;
          return -1;
        },
      }) as never;

    try {
      await expect(
        playersCache.mergePrices([{ elementId: 2, value: 61 }], [1, 2], '2627'),
      ).rejects.toThrow('Refusing to merge prices into incomplete players cache');
    } finally {
      redisSingleton.getClient = originalGetClient;
    }

    expect(evalCalls).toBe(1);
  });
});
