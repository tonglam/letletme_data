import { describe, expect, test } from 'bun:test';

import { playerValuesCache } from '../../src/cache/operations';
import { redisSingleton } from '../../src/cache/singleton';
import type { PlayerValue } from '../../src/domain/player-values';

const value: PlayerValue = {
  elementId: 1,
  webName: 'Player',
  elementType: 3,
  elementTypeName: 'MID',
  eventId: 1,
  teamId: 1,
  teamName: 'Team',
  teamShortName: 'TEA',
  value: 50,
  changeDate: '20260802',
  changeType: 'Start',
  lastValue: 0,
};

describe('player-values cache merge', () => {
  test('clears the negative marker only after positive HSET succeeds', async () => {
    const originalGetClient = redisSingleton.getClient;
    const operations: string[] = [];
    redisSingleton.getClient = async () =>
      ({
        hset: async () => {
          operations.push('hset');
          return 1;
        },
        del: async () => {
          operations.push('del');
          return 1;
        },
      }) as never;

    try {
      await playerValuesCache.merge('20260802', [value]);
    } finally {
      redisSingleton.getClient = originalGetClient;
    }

    expect(operations).toEqual(['hset', 'del']);
  });

  test('fails without clearing the negative marker when HSET fails', async () => {
    const originalGetClient = redisSingleton.getClient;
    let deleteCalls = 0;
    redisSingleton.getClient = async () =>
      ({
        hset: async () => {
          throw new Error('WRONGTYPE');
        },
        del: async () => {
          deleteCalls += 1;
          return 1;
        },
      }) as never;

    try {
      await expect(playerValuesCache.merge('20260802', [value])).rejects.toThrow('WRONGTYPE');
    } finally {
      redisSingleton.getClient = originalGetClient;
    }

    expect(deleteCalls).toBe(0);
  });

  test('deletes only named stale fields without replacing the hash', async () => {
    const originalGetClient = redisSingleton.getClient;
    const calls: Array<{ command: string; args: string[] }> = [];
    redisSingleton.getClient = async () =>
      ({
        hdel: async (...fields: string[]) => {
          calls.push({ command: 'hdel', args: fields });
          return fields.length;
        },
      }) as never;

    try {
      await playerValuesCache.deleteFields('20260802', ['wrong-field', '999']);
    } finally {
      redisSingleton.getClient = originalGetClient;
    }

    expect(calls).toEqual([
      { command: 'hdel', args: ['PlayerValue:20260802', 'wrong-field', '999'] },
    ]);
  });
});
