import { describe, expect, mock, test } from 'bun:test';

import {
  createMyFplSnapshotInvalidationDispatcher,
  type InvalidationOutboxDependencies,
} from '../../src/services/my-fpl-snapshot-invalidation.service';

type ClaimedRow = {
  outbox_id: string;
  season_id: number;
  event_id: number;
  revision: number;
  tournament_id: number;
  reason: string;
  season_code: string;
};

type FakeSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) & {
  begin<T>(callback: (tx: FakeSql) => Promise<T>): Promise<T>;
};

function row(index: number, overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    outbox_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    season_id: 2026,
    event_id: 7,
    revision: index,
    tournament_id: 99,
    reason: 'TOURNAMENT_DELETED',
    season_code: '2627',
    ...overrides,
  };
}

function fakeDatabase(input: {
  claimed?: readonly ClaimedRow[];
  remaining?: number;
  ownsLease?: boolean;
}) {
  const queries: string[] = [];
  const tagged = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?');
    queries.push(text);
    if (text.includes('SELECT count(*)::integer AS count')) {
      return [{ count: input.remaining ?? 0 }];
    }
    if (text.includes('SELECT outbox.outbox_id') && text.includes('JOIN fpl.seasons')) {
      return [...(input.claimed ?? [])];
    }
    if (text.includes('SELECT outbox_id') && text.includes('lease_owner')) {
      return input.ownsLease === false ? [] : [{ outbox_id: 'owned' }];
    }
    return [];
  }) as FakeSql;
  tagged.begin = async <T>(callback: (tx: FakeSql) => Promise<T>): Promise<T> => callback(tagged);
  return { db: tagged, queries };
}

function dependencies(
  db: FakeSql,
  redisResult: (revision: string) => unknown = () => ['deleted'],
): InvalidationOutboxDependencies {
  return {
    getDbClient: async () => db as never,
    getRedisClient: async () =>
      ({
        eval: async (_script: string, _keyCount: number, _key: string, revision: string) =>
          redisResult(revision),
      }) as never,
    makeOwner: () => 'worker-1',
  };
}

describe('My FPL snapshot invalidation dispatcher', () => {
  test('validates limits and requested outbox identities before opening infrastructure', async () => {
    const dbFactory = mock(async () => fakeDatabase({}).db as never);
    const dispatch = createMyFplSnapshotInvalidationDispatcher({ getDbClient: dbFactory });

    await expect(dispatch({ limit: 0 })).rejects.toThrow('between 1 and 100');
    await expect(dispatch({ limit: 101 })).rejects.toThrow('between 1 and 100');
    await expect(dispatch({ outboxIds: ['not-a-uuid'] })).rejects.toThrow('must be UUIDs');
    expect(await dispatch({ outboxIds: [] })).toEqual({
      claimed: 0,
      delivered: 0,
      superseded: 0,
      failed: 0,
      remaining: 0,
    });
    expect(dbFactory).not.toHaveBeenCalled();
  });

  test('reports durable remaining work when no row can be claimed', async () => {
    const { db } = fakeDatabase({ claimed: [], remaining: 3 });
    const dispatch = createMyFplSnapshotInvalidationDispatcher(dependencies(db));
    expect(await dispatch({ seasonId: 2026, eventId: 7, tournamentId: 99 })).toEqual({
      claimed: 0,
      delivered: 0,
      superseded: 0,
      failed: 0,
      remaining: 3,
    });
  });

  test('delivers matching pointers, supersedes newer pointers and releases invalid rows', async () => {
    const claimed = [row(1), row(2), row(3, { reason: 'UNSUPPORTED' }), row(4)];
    const { db, queries } = fakeDatabase({ claimed, remaining: 2 });
    const dispatch = createMyFplSnapshotInvalidationDispatcher(
      dependencies(db, (revision) => {
        if (revision === '1') return ['deleted'];
        if (revision === '2') return ['different'];
        return ['unknown'];
      }),
    );

    expect(await dispatch({ limit: 4 })).toEqual({
      claimed: 4,
      delivered: 1,
      superseded: 1,
      failed: 2,
      remaining: 2,
    });
    expect(queries.some((query) => /interval '2 minutes'/.test(query))).toBe(true);
    expect(queries.some((query) => /interval '5 minutes'/.test(query))).toBe(true);
    expect(queries.some((query) => query.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  test('persists every claimed row as failed when Redis is unavailable before CAS', async () => {
    const { db, queries } = fakeDatabase({ claimed: [row(1), row(2)], remaining: 2 });
    const dispatch = createMyFplSnapshotInvalidationDispatcher({
      getDbClient: async () => db as never,
      getRedisClient: async () => {
        throw new Error('redis unavailable');
      },
      makeOwner: () => 'worker-1',
    });

    expect(await dispatch()).toEqual({
      claimed: 2,
      delivered: 0,
      superseded: 0,
      failed: 2,
      remaining: 2,
    });
    expect(queries.filter((query) => /SET status = 'FAILED'/.test(query))).toHaveLength(3);
  });

  test('does not acknowledge a row after its lease ownership is lost', async () => {
    const { db } = fakeDatabase({ claimed: [row(1)], ownsLease: false, remaining: 1 });
    const dispatch = createMyFplSnapshotInvalidationDispatcher(dependencies(db));
    expect(await dispatch()).toEqual({
      claimed: 1,
      delivered: 0,
      superseded: 0,
      failed: 0,
      remaining: 1,
    });
  });
});
