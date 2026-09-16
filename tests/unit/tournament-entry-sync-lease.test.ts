import { afterEach, describe, expect, mock, test } from 'bun:test';

const values = new Map<string, string>();

const fakeRedis = {
  getClient: async () => ({
    set: async (
      key: string,
      value: string,
      ...args: Array<string | number>
    ): Promise<string | null> => {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    eval: async (
      _script: string,
      _keyCount: number,
      key: string,
      token: string,
    ): Promise<number> => {
      if (values.get(key) !== token) return 0;
      values.delete(key);
      return 1;
    },
  }),
};

mock.module('../../src/queues/redis', () => ({ queueRedisSingleton: fakeRedis }));

const { tournamentEntrySyncLeaseKey, withTournamentEntrySyncLease } = await import(
  '../../src/utils/tournament-entry-sync-lease'
);

describe('tournament entry/GW coordination lease', () => {
  afterEach(() => {
    values.clear();
  });

  test('uses one queue-coordination identity per season/event/entry', () => {
    expect(tournamentEntrySyncLeaseKey({ seasonId: 2627, eventId: 4, entryId: 12345 })).toBe(
      'llm:queue:coordination:tournament-entry-sync:v1:2627:4:12345',
    );
  });

  test('serializes competing workers and releases the token-fenced lease', async () => {
    const scope = { seasonId: 2627, eventId: 4, entryId: 12345 };
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];

    const run = (label: string) =>
      withTournamentEntrySyncLease(
        scope,
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          order.push(`${label}:start`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push(`${label}:end`);
          active -= 1;
          return label;
        },
        { leaseMs: 2_000, waitMs: 1_000, pollMs: 5 },
      );

    const [first, second] = await Promise.all([run('first'), run('second')]);

    expect(new Set([first, second])).toEqual(new Set(['first', 'second']));
    expect(maximumActive).toBe(1);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(values.size).toBe(0);
  });
});
