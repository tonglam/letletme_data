import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { databaseSingleton, databaseTransactionStorage, getDb } from '../../src/db/singleton';
import { syncEntryInfo, type EntryInfoClient } from '../../src/services/entry-info.service';
import { acquireMutationScopes, withMutationScopes } from '../../src/utils/mutation-scopes';
import { recordedEntrySummary } from '../fixtures/entry-info.fixtures';
import { withEntrySeasonSyncTransaction } from '../../src/repositories/entry-event-transfers';
import { fplClient } from '../../src/clients/fpl';
import { syncEntryEventResults, syncEntryEventTransfers } from '../../src/services/entries.service';
import { createEntryEventResultsRepository } from '../../src/repositories/entry-event-results';
import { eventRepository } from '../../src/repositories/events';
import type { RawFPLEntryEventPicksResponse, RawFPLEventLiveResponse } from '../../src/types';

const db = postgres(process.env.DATABASE_URL!, { max: 2 });
const season = { seasonId: 2091, seasonCode: '9192' };
const ids = [919201, 919202, 919203];

test('a rejected older rich result cannot enter picks publication', async () => {
  await syncEntryInfo(season, ids[0]!, client('original'), 0);
  const picks: RawFPLEntryEventPicksResponse = {
    active_chip: null,
    automatic_subs: [],
    entry_history: {
      event: 1,
      points: 60,
      total_points: 60,
      rank: 100,
      overall_rank: 1000,
      bank: 10,
      value: 1000,
      event_transfers: 0,
      event_transfers_cost: 0,
      points_on_bench: 0,
    },
    picks: Array.from({ length: 15 }, (_, index) => ({
      element: index + 1,
      position: index + 1,
      multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
      is_captain: index === 0,
      is_vice_captain: index === 1,
    })),
  };
  const live = {
    elements: picks.picks.map((pick) => ({ id: pick.element, stats: { total_points: 2 } })),
  };
  const entered = gate();
  const release = gate();
  const provider = spyOn(fplClient, 'getEntryEventPicks').mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return picks;
  });
  const eventLive = spyOn(fplClient, 'getEventLive').mockResolvedValue(
    live as RawFPLEventLiveResponse,
  );
  const publicationBoundary = spyOn(eventRepository, 'findById').mockImplementation(async () => {
    throw new Error('Rejected source must not enter publication');
  });
  const old = syncEntryEventResults(season, ids[0]!, 1).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    const accepted = await withEntrySeasonSyncTransaction(season, ids[0]!, (tx) =>
      createEntryEventResultsRepository(tx).upsertFromPicksAndLive(
        season,
        ids[0]!,
        1,
        picks,
        { elements: live.elements.map((row) => ({ ...row, stats: { total_points: 4 } })) },
        new Date('2091-01-01T00:00:00Z'),
      ),
    );
    expect(accepted).toBe(true);
    release.resolve();
    expect(await old).toBeNull();
    expect(publicationBoundary).not.toHaveBeenCalled();
    const [saved] = await db`SELECT event_points FROM competition.entry_event_results
      WHERE season_id=${season.seasonId} AND entry_id=${ids[0]!} AND event_id=1`;
    expect(saved!.event_points).toBe(48);
  } finally {
    release.resolve();
    await old;
    provider.mockRestore();
    eventLive.mockRestore();
    publicationBoundary.mockRestore();
    await db`DELETE FROM ops.mutation_scopes WHERE scope_key='entry-event-results:event:1'`;
  }
}, 15000);

test('transfer fetch is unlocked but its canonical commit waits for the Trends publication scope', async () => {
  await syncEntryInfo(season, ids[0]!, client('original'), 0);
  const providerEntered = gate();
  const releaseProvider = gate();
  const publicationLocked = gate();
  const releasePublication = gate();
  const eventId = 9191;
  const scope = `entry-event-transfers:event:${eventId}`;
  const provider = spyOn(fplClient, 'getEntryTransfers').mockImplementation(async () => {
    expect(databaseTransactionStorage.getStore()).toBeUndefined();
    providerEntered.resolve();
    await releaseProvider.promise;
    return [];
  });
  const writer = syncEntryEventTransfers(season, ids[0]!, eventId, {
    pointsByElement: new Map(),
  }).then(
    () => null,
    (error: unknown) => error,
  );
  let publisher: Promise<unknown> | undefined;
  try {
    await providerEntered.promise;
    let publisherPid = 0;
    publisher = db.begin(async (tx) => {
      await acquireMutationScopes(tx, [scope]);
      const [row] = await tx`SELECT pg_backend_pid() AS pid`;
      publisherPid = Number(row!.pid);
      publicationLocked.resolve();
      await releasePublication.promise;
    });
    await publicationLocked.promise;
    releaseProvider.resolve();
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await db`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE ${publisherPid} = ANY(pg_blocking_pids(pid))
      ) AS blocked`;
      if (row!.blocked) {
        blocked = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
    const [entry] = await db`SELECT transfers_source_checked_at FROM competition.entries
      WHERE season_id=${season.seasonId} AND entry_id=${ids[0]!}`;
    expect(entry!.transfers_source_checked_at).toBeNull();
  } finally {
    releaseProvider.resolve();
    releasePublication.resolve();
    await publisher;
    const result = await writer;
    provider.mockRestore();
    await db`DELETE FROM ops.mutation_scopes WHERE scope_key=${scope}`;
    expect(result).toBeNull();
  }
  const [entry] = await db`SELECT transfers_synced_through_event_id FROM competition.entries
    WHERE season_id=${season.seasonId} AND entry_id=${ids[0]!}`;
  expect(entry!.transfers_synced_through_event_id).toBe(eventId);
}, 15000);

test.each(['entry-picks', 'entry-transfers', 'entry-results'])(
  '%s batch permits independent commits and rollback while another entry is pending',
  async (jobName) => {
    await syncEntryInfo(season, ids[0]!, client('original'), 0);
    await syncEntryInfo(season, ids[1]!, client('original'), 0);
    await withMutationScopes({ queueName: 'entry-sync', jobName, eventId: 1 }, async () => {
      expect(databaseTransactionStorage.getStore()).toBeUndefined();
      const release = gate();
      const failing = (async () => {
        // Model the provider wait before entering the repository transaction.
        // This must work even with the production default of one pool slot.
        await release.promise;
        return withEntrySeasonSyncTransaction(season, ids[0]!, async (tx) => {
          await tx.execute(sql`UPDATE competition.entries SET entry_name='must rollback'
            WHERE season_id=${season.seasonId} AND entry_id=${ids[0]!}`);
          throw new Error('entry write failed');
        });
      })();
      const outcome = failing.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await withEntrySeasonSyncTransaction(season, ids[1]!, async (tx) => {
          await tx.execute(sql`UPDATE competition.entries SET entry_name='committed'
            WHERE season_id=${season.seasonId} AND entry_id=${ids[1]!}`);
        });
        // Read through a separate connection before the batch returns, exactly
        // when a caller may advertise the durable checkpoint to Redis.
        const rows = await db`SELECT entry_name FROM competition.entries
          WHERE season_id=${season.seasonId} AND entry_id=${ids[1]!}`;
        expect(rows[0]?.entry_name).toBe('committed');
      } finally {
        release.resolve();
        expect(await outcome).toBeInstanceOf(Error);
      }
      const rows = await db`SELECT entry_name FROM competition.entries
        WHERE season_id=${season.seasonId} ORDER BY entry_id`;
      expect(rows.map((row) => row.entry_name)).toEqual(['original', 'committed']);
    });
  },
  15000,
);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function client(
  name: string,
  beforeSummary: () => Promise<void> = async () => {},
): EntryInfoClient {
  return {
    async getEntrySummary(id) {
      expect(databaseTransactionStorage.getStore()).toBeUndefined();
      await beforeSummary();
      return {
        ...structuredClone(recordedEntrySummary),
        id,
        name,
        leagues: { classic: [], h2h: [] },
      };
    },
    async getEntryHistory() {
      expect(databaseTransactionStorage.getStore()).toBeUndefined();
      return { current: [], past: [], chips: [] };
    },
  };
}

beforeAll(async () => {
  await db`INSERT INTO fpl.seasons (season_id, season_code, display_name, start_year, end_year, lifecycle_state)
    VALUES (2091, '9192', '2091/92', 2091, 2092, 'reference_only')`;
  await db`INSERT INTO fpl.events (season_id,event_id,name) VALUES (2091,1,'Test GW1')`;
  await db`INSERT INTO fpl.teams (season_id,team_id,code,name,short_name) VALUES (2091,1,1,'Test team','TST')`;
  await db`INSERT INTO fpl.players (season_id,element_id,code,element_type,team_id,web_name)
    VALUES (2091,1,1,1,1,'Test captain')`;
});
beforeEach(async () => {
  await db`DELETE FROM competition.entry_event_results WHERE season_id=2091`;
  await db`DELETE FROM competition.entry_leagues WHERE season_id = 2091`;
  await db`DELETE FROM competition.entries WHERE season_id = 2091`;
  await db`DELETE FROM ops.mutation_scopes WHERE scope_key LIKE 'entry-core:2091:%'`;
});
afterAll(async () => {
  await db`DELETE FROM competition.entry_event_results WHERE season_id=2091`;
  await db`DELETE FROM competition.entry_leagues WHERE season_id = 2091`;
  await db`DELETE FROM competition.entries WHERE season_id = 2091`;
  await db`DELETE FROM ops.mutation_scopes WHERE scope_key LIKE 'entry-core:2091:%'`;
  await db`DELETE FROM fpl.players WHERE season_id=2091`;
  await db`DELETE FROM fpl.teams WHERE season_id=2091`;
  await db`DELETE FROM fpl.events WHERE season_id=2091`;
  await db`DELETE FROM fpl.seasons WHERE season_id = 2091`;
  await databaseSingleton.disconnect();
  await db.end();
});

test('slow upstream holds no profile scope; another entry commits independently', async () => {
  const entered = gate();
  const release = gate();
  const slow = syncEntryInfo(
    season,
    ids[0]!,
    client('slow', async () => {
      entered.resolve();
      await release.promise;
    }),
    0,
  );
  try {
    await entered.promise;
    const scopes =
      await db`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key = ${`entry-core:2091:${ids[0]}`}`;
    expect(scopes).toHaveLength(0);
    await syncEntryInfo(season, ids[1]!, client('fast'), 0);
    const saved =
      await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[1]!}`;
    expect(saved[0]?.entry_name).toBe('fast');
  } finally {
    release.resolve();
    await slow;
  }
}, 15000);

test('failed child write rolls back its parent without undoing another entry', async () => {
  await syncEntryInfo(season, ids[0]!, client('original'), 0);
  const bad = client('must rollback');
  bad.getEntrySummary = async (id) => ({
    ...structuredClone(recordedEntrySummary),
    id,
    name: 'must rollback',
    leagues: { classic: [], h2h: [] },
  });
  bad.getEntryHistory = async () => ({
    current: [],
    chips: [],
    past: [{ season_name: 'invalid', total_points: 1, rank: 1 }],
  });
  const results = await Promise.allSettled([
    syncEntryInfo(season, ids[0]!, bad, 0),
    syncEntryInfo(season, ids[1]!, client('committed independently'), 0),
  ]);
  expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
  const rows =
    await db`SELECT entry_id,entry_name FROM competition.entries WHERE season_id=2091 ORDER BY entry_id`;
  expect(rows.map((row) => row.entry_name)).toEqual(['original', 'committed independently']);
}, 15000);

test('an older delayed response cannot overwrite a newer committed profile', async () => {
  const entered = gate();
  const release = gate();
  const old = syncEntryInfo(
    season,
    ids[2]!,
    client('old response', async () => {
      entered.resolve();
      await release.promise;
    }),
    0,
  );
  // Attach rejection handling before unblocking the delayed operation.
  const outcome = old.then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await entered.promise;
    await db`SELECT pg_sleep(0.01)`;
    await syncEntryInfo(season, ids[2]!, client('new response'), 0);
  } finally {
    release.resolve();
  }
  expect(await outcome).toMatchObject({ code: 'ENTRY_PROFILE_SOURCE_STALE' });
  const rows =
    await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[2]!}`;
  expect(rows[0]?.entry_name).toBe('new response');
}, 15000);

test('worker batch scope leaves profiles independent and tournament callers retain outer atomicity', async () => {
  await withMutationScopes({ queueName: 'entry-sync', jobName: 'entry-info' }, async () => {
    expect(databaseTransactionStorage.getStore()).toBeUndefined();
    await Promise.all([
      syncEntryInfo(season, ids[0]!, client('batch one'), 0),
      syncEntryInfo(season, ids[1]!, client('batch two'), 0),
    ]);
  });
  const nestedClient: EntryInfoClient = {
    async getEntrySummary(id) {
      return {
        ...structuredClone(recordedEntrySummary),
        id,
        name: 'nested rollback',
        leagues: { classic: [], h2h: [] },
      };
    },
    async getEntryHistory() {
      return { current: [], past: [], chips: [] };
    },
  };
  await expect(
    withMutationScopes(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        scopes: ['entry-core:2091:919203'],
      },
      async () => {
        await syncEntryInfo(season, ids[2]!, nestedClient, 0);
        expect(databaseTransactionStorage.getStore()?.postCommitActions.length).toBeGreaterThan(0);
        const uncommitted =
          await db`SELECT entry_id FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[2]!}`;
        expect(uncommitted).toHaveLength(0);
        throw new Error('rollback outer lifecycle');
      },
    ),
  ).rejects.toThrow('rollback outer lifecycle');
  const rows =
    await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 ORDER BY entry_id`;
  expect(rows.map((row) => row.entry_name)).toEqual(['batch one', 'batch two']);
}, 15000);

test('equal millisecond observations cannot overwrite the first committed profile', async () => {
  // Mock only the source clock in a subprocess so the shared integration module
  // registry and the real database transaction/locking implementation stay intact.
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    const observed = new Date('2091-01-01T00:00:00.123Z');
    mock.module('./src/db/ordering-timestamp', () => ({
      readDatabaseOrderingTimestamp: async () => ({date: observed, exact: observed.toISOString()}),
    }));
    const { syncEntryInfo } = await import('./src/services/entry-info.service');
    const { databaseSingleton } = await import('./src/db/singleton');
    const { recordedEntrySummary } = await import('./tests/fixtures/entry-info.fixtures');
    const client = (name) => ({
      getEntrySummary: async (id) => ({...recordedEntrySummary, id, name, leagues: {classic: [], h2h: []}}),
      getEntryHistory: async () => ({current: [], past: [], chips: []}),
    });
    try {
      await syncEntryInfo({seasonId:2091, seasonCode:'9192'}, 919203, client('first committed'), 0);
      await assert.rejects(
        syncEntryInfo({seasonId:2091, seasonCode:'9192'}, 919203, client('equal contender'), 0),
        {code:'ENTRY_PROFILE_SOURCE_STALE'},
      );
    } finally { await databaseSingleton.disconnect(); }
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  const rows =
    await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=919203`;
  expect(rows[0]?.entry_name).toBe('first committed');
}, 15000);

test('entry deadline cancels a lock wait and never runs its write after the lock is released', async () => {
  await syncEntryInfo(season, ids[0]!, client('original'), 0);
  const locked = gate();
  const release = gate();
  const owner = db.begin(async (tx) => {
    await tx`SELECT entry_id FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[0]!} FOR UPDATE`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  let writes = 0;
  try {
    await expect(
      withEntrySeasonSyncTransaction(
        season,
        ids[0]!,
        async (tx) => {
          writes += 1;
          await tx.execute(
            sql`UPDATE competition.entries SET entry_name='late write' WHERE season_id=2091 AND entry_id=${ids[0]!}`,
          );
        },
        { timeoutMs: 150 },
      ),
    ).rejects.toThrow();
    expect(writes).toBe(0);
  } finally {
    release.resolve();
    await owner;
  }
  await Bun.sleep(200);
  expect(writes).toBe(0);
  expect(
    (
      await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[0]!}`
    )[0]?.entry_name,
  ).toBe('original');
}, 10000);

test('deadline cancels SQL in a nested savepoint and rolls back earlier entry writes before rejection', async () => {
  await syncEntryInfo(season, ids[0]!, client('original'), 0);
  await expect(
    withEntrySeasonSyncTransaction(
      season,
      ids[0]!,
      async (tx) => {
        await tx.execute(
          sql`UPDATE competition.entries SET entry_name='must rollback' WHERE season_id=2091 AND entry_id=${ids[0]!}`,
        );
        await tx.transaction(async (nested) => {
          await nested.execute(sql`SELECT pg_sleep(3)`);
        });
      },
      { timeoutMs: 150 },
    ),
  ).rejects.toThrow();
  expect(
    (
      await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[0]!}`
    )[0]?.entry_name,
  ).toBe('original');
  // Cancellation has settled: the fence and row lock are immediately reusable.
  await withEntrySeasonSyncTransaction(
    season,
    ids[0]!,
    async (tx) => {
      await tx.execute(
        sql`UPDATE competition.entries SET entry_name='recovered' WHERE season_id=2091 AND entry_id=${ids[0]!}`,
      );
    },
    { timeoutMs: 1000 },
  );
  expect(
    (
      await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[0]!}`
    )[0]?.entry_name,
  ).toBe('recovered');
}, 10000);

test('one absolute deadline covers multiple individually short statements', async () => {
  await syncEntryInfo(season, ids[0]!, client('original'), 0);
  let completed = 0;
  await expect(
    withEntrySeasonSyncTransaction(
      season,
      ids[0]!,
      async (tx) => {
        await tx.execute(
          sql`UPDATE competition.entries SET entry_name='must rollback' WHERE season_id=2091 AND entry_id=${ids[0]!}`,
        );
        for (let n = 0; n < 4; n += 1) {
          await tx.execute(sql`SELECT pg_sleep(0.12)`);
          completed += 1;
        }
      },
      { timeoutMs: 300 },
    ),
  ).rejects.toThrow();
  expect(completed).toBeLessThan(4);
  expect(
    (
      await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[0]!}`
    )[0]?.entry_name,
  ).toBe('original');
}, 10000);

test('an expired entry savepoint leaves its enclosing transaction usable without leaking the deadline', async () => {
  await syncEntryInfo(season, ids[0]!, client('original'), 0);
  await withMutationScopes(
    { queueName: 'test', jobName: 'outer-deadline', scopes: [`entry-core:2091:${ids[0]!}`] },
    async () => {
      await expect(
        withEntrySeasonSyncTransaction(
          season,
          ids[0]!,
          async (tx) => {
            await tx.execute(
              sql`UPDATE competition.entries SET entry_name='must rollback' WHERE season_id=2091 AND entry_id=${ids[0]!}`,
            );
            await tx.execute(sql`SELECT pg_sleep(3)`);
          },
          { timeoutMs: 150 },
        ),
      ).rejects.toThrow();
      await withEntrySeasonSyncTransaction(season, ids[0]!, async (tx) => {
        await tx.execute(sql`SELECT pg_sleep(0.2)`);
        await tx.execute(
          sql`UPDATE competition.entries SET entry_name='outer recovered' WHERE season_id=2091 AND entry_id=${ids[0]!}`,
        );
      });
    },
  );
  expect(
    (
      await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[0]!}`
    )[0]?.entry_name,
  ).toBe('outer recovered');
}, 10000);

test('an expired callback cannot commit even when no SQL is in flight at its deadline', async () => {
  await syncEntryInfo(season, ids[0]!, client('original'), 0);
  await expect(
    withEntrySeasonSyncTransaction(
      season,
      ids[0]!,
      async (tx) => {
        await tx.execute(
          sql`UPDATE competition.entries SET entry_name='must rollback' WHERE season_id=2091 AND entry_id=${ids[0]!}`,
        );
        await Bun.sleep(250);
      },
      { timeoutMs: 150 },
    ),
  ).rejects.toThrow('persistence deadline');
  expect(
    (
      await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[0]!}`
    )[0]?.entry_name,
  ).toBe('original');
}, 10000);

test('entry persistence bounds outer pool acquisition and fences abandoned callbacks', async () => {
  await syncEntryInfo(season, ids[0]!, client('original'), 0);
  const handle = await getDb();
  const occupied = gate();
  const release = gate();
  const owner = handle.transaction(async () => {
    occupied.resolve();
    await release.promise;
  });
  await occupied.promise;
  let writes = 0;
  const write = () =>
    withEntrySeasonSyncTransaction(
      season,
      ids[0]!,
      async (tx) => {
        writes += 1;
        await tx.execute(
          sql`UPDATE competition.entries SET entry_name='late write' WHERE season_id=2091 AND entry_id=${ids[0]!}`,
        );
      },
      { timeoutMs: 150 },
    );
  const started = Date.now();
  try {
    await expect(write()).rejects.toThrow('transaction acquisition');
    expect(Date.now() - started).toBeLessThan(1000);
    for (let n = 0; n < 3; n += 1) await expect(write()).rejects.toThrow('transaction acquisition');
    expect(writes).toBe(0);
  } finally {
    release.resolve();
    await owner;
  }
  await Bun.sleep(200);
  expect(writes).toBe(0);
  expect(
    (
      await db`SELECT entry_name FROM competition.entries WHERE season_id=2091 AND entry_id=${ids[0]!}`
    )[0]?.entry_name,
  ).toBe('original');
  await write();
  expect(writes).toBe(1);
}, 10000);
