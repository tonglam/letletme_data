import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import postgres from 'postgres';
import { databaseSingleton, databaseTransactionStorage } from '../../src/db/singleton';
import { syncEntryInfo, type EntryInfoClient } from '../../src/services/entry-info.service';
import { withMutationScopes } from '../../src/utils/mutation-scopes';
import { recordedEntrySummary } from '../fixtures/entry-info.fixtures';

const db = postgres(process.env.DATABASE_URL!, { max: 2 });
const season = { seasonId: 2091, seasonCode: '9192' };
const ids = [919201, 919202, 919203];
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
});
beforeEach(async () => {
  await db`DELETE FROM competition.entry_leagues WHERE season_id = 2091`;
  await db`DELETE FROM competition.entries WHERE season_id = 2091`;
  await db`DELETE FROM ops.mutation_scopes WHERE scope_key LIKE 'entry-core:2091:%'`;
});
afterAll(async () => {
  await db`DELETE FROM competition.entry_leagues WHERE season_id = 2091`;
  await db`DELETE FROM competition.entries WHERE season_id = 2091`;
  await db`DELETE FROM ops.mutation_scopes WHERE scope_key LIKE 'entry-core:2091:%'`;
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
