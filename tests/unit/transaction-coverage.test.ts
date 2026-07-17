import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { DbEntryInfo, DbTournamentKnockoutResult } from '../../src/db/schemas/index.schema';
import type { TournamentSyncContext } from '../../src/domain/tournament';
import type { RawFPLEntrySummary } from '../../src/types';
import { singleRawEventLiveElementFixture } from '../fixtures/event-lives.fixtures';

/**
 * FP-16 transaction coverage: atomicity wiring for the three packed writes.
 * Module mocks are registered before the services are imported (dynamic
 * imports below) so services pick up the fake db/repository graph.
 */

// ---------------------------------------------------------------------------
// Shared fake db handle: currentDb is (re)assigned per test.
// ---------------------------------------------------------------------------

type TxCallback = (tx: unknown) => Promise<unknown>;
let currentDb: { transaction: (cb: TxCallback) => Promise<unknown> };

mock.module('../../src/db/singleton', () => ({
  getDb: async () => currentDb,
  getDbClient: async () => {
    throw new Error('getDbClient is not mocked in transaction-coverage tests');
  },
  databaseSingleton: {},
}));

// ---------------------------------------------------------------------------
// event-lives sync mocks. Modules other test files exercise for real
// (fpl client, transformers, event-lives repo) delegate to the real
// implementation for anything this file does not explicitly stub, because
// mock.module overwrites the shared registry entry for every test file.
// ---------------------------------------------------------------------------

let activeTx: unknown;

const realFpl = await import('../../src/clients/fpl');
const realEventLivesRepo = await import('../../src/repositories/event-lives');
const realExplainsRepo = await import('../../src/repositories/event-live-explains');

// fplClient.getEventLive is stubbed by direct mutation (restored in afterAll):
// mock.module would replace the whole module for every test file, and
// fpl-client.test.ts exercises the real client. Real transformers run for the
// same reason — event-lives/event-live-explains tests need them intact.
const originalGetEventLive = realFpl.fplClient.getEventLive;
realFpl.fplClient.getEventLive = mock(async () => ({
  elements: [singleRawEventLiveElementFixture],
})) as never;
afterAll(() => {
  realFpl.fplClient.getEventLive = originalGetEventLive;
});

const txLivesUpsertBatch = mock(async (rows: unknown[]) => rows);
const txExplainsUpsertBatch = mock(async (rows: unknown[]) => rows);
const createEventLiveRepository = mock((db?: unknown) =>
  db === activeTx
    ? { upsertBatch: txLivesUpsertBatch }
    : realEventLivesRepo.createEventLiveRepository(db as never),
);
const createEventLiveExplainsRepository = mock((db?: unknown) =>
  db === activeTx
    ? { upsertBatch: txExplainsUpsertBatch }
    : realExplainsRepo.createEventLiveExplainsRepository(db as never),
);

mock.module('../../src/repositories/event-lives', () => ({
  ...realEventLivesRepo,
  createEventLiveRepository,
  eventLiveRepository: {
    ...realEventLivesRepo.eventLiveRepository,
    findByEventId: mock(async () => []),
  },
}));
mock.module('../../src/repositories/event-live-explains', () => ({
  ...realExplainsRepo,
  createEventLiveExplainsRepository,
}));

const eventLivesCacheSet = mock(async () => {});
const realCacheOps = await import('../../src/cache/operations');
mock.module('../../src/cache/operations', () => ({
  ...realCacheOps,
  eventLivesCache: {
    ...realCacheOps.eventLivesCache,
    set: eventLivesCacheSet,
    getByEventId: mock(async () => null),
  },
}));

// ---------------------------------------------------------------------------
// knockout sync mocks
// ---------------------------------------------------------------------------

const knockoutCallLog: string[] = [];

const txResultsUpsertBatch = mock(async (rows: unknown[], label = 'results') => {
  knockoutCallLog.push(label);
  return rows.length;
});
const txKnockoutsUpsertBatch = mock(async (rows: unknown[], label = 'knockouts') => {
  knockoutCallLog.push(label);
  return rows.length;
});

const matchOneResultRow = {
  tournamentId: 100,
  eventId: 5,
  matchId: 1,
  playAgainstId: 1,
  homeEntryId: 11,
  awayEntryId: 22,
  homeNetPoints: null,
  awayNetPoints: null,
  homeGoalsScored: null,
  homeGoalsConceded: null,
  awayGoalsScored: null,
  awayGoalsConceded: null,
  matchWinner: null,
};
const matchOneResultRowAfterSync = {
  ...matchOneResultRow,
  homeNetPoints: 50,
  awayNetPoints: 40,
  homeGoalsScored: 0,
  homeGoalsConceded: 0,
  awayGoalsScored: 0,
  awayGoalsConceded: 0,
  matchWinner: 11,
};
const nextResultRow = {
  tournamentId: 100,
  eventId: 6,
  matchId: 3,
  playAgainstId: 2,
  homeEntryId: null,
  awayEntryId: null,
  homeNetPoints: null,
  awayNetPoints: null,
  homeGoalsScored: null,
  homeGoalsConceded: null,
  awayGoalsScored: null,
  awayGoalsConceded: null,
  matchWinner: null,
};
const knockoutRow = {
  tournamentId: 100,
  matchId: 1,
  round: 1,
  nextMatchId: 3,
  homeEntryId: 11,
  awayEntryId: 22,
};
const nextKnockoutRow = {
  tournamentId: 100,
  matchId: 3,
  round: 2,
  nextMatchId: null,
  homeEntryId: null,
  awayEntryId: null,
};

const txResultsFindByMatchIds = mock(async (_tournamentId: number, matchIds: number[]) => {
  if (matchIds.includes(1)) {
    return [matchOneResultRowAfterSync] as unknown as DbTournamentKnockoutResult[];
  }
  return [nextResultRow] as unknown as DbTournamentKnockoutResult[];
});
const txKnockoutsFindByEndedEvent = mock(async () => [knockoutRow]);
const txKnockoutsFindByRound = mock(async () => [nextKnockoutRow]);

const createTournamentKnockoutResultsRepository = mock((_db?: unknown) => ({
  upsertBatch: (rows: unknown[]) => txResultsUpsertBatch(rows, 'results'),
  findByTournamentAndMatchIds: txResultsFindByMatchIds,
}));
const createTournamentKnockoutsRepository = mock((_db?: unknown) => ({
  upsertBatch: (rows: unknown[]) => txKnockoutsUpsertBatch(rows, 'knockouts'),
  findByTournamentAndEndedEvent: txKnockoutsFindByEndedEvent,
  findByTournamentAndRound: txKnockoutsFindByRound,
}));

const singletonResultsFindByMatchIds = mock(async () => {
  throw new Error('knockout read escaped the transaction');
});

mock.module('../../src/repositories/tournament-knockout-results', () => ({
  createTournamentKnockoutResultsRepository,
  tournamentKnockoutResultsRepository: {
    findByTournamentAndEvent: mock(async () => [matchOneResultRow]),
    findByTournamentAndMatchIds: singletonResultsFindByMatchIds,
  },
}));
mock.module('../../src/repositories/tournament-knockouts', () => ({
  createTournamentKnockoutsRepository,
  tournamentKnockoutsRepository: {},
}));

mock.module('../../src/repositories/entry-event-results', () => ({
  entryEventResultsRepository: {
    findByEventAndEntryIds: mock(async () => [
      { entryId: 11, eventNetPoints: 50, eventPicks: [], eventChip: null },
      { entryId: 22, eventNetPoints: 40, eventPicks: [], eventChip: null },
    ]),
  },
}));
mock.module('../../src/repositories/tournament-entries', () => ({
  tournamentEntryRepository: {
    findEntryIdsByTournamentId: mock(async () => [11, 22]),
  },
}));
mock.module('../../src/repositories/tournament-infos', () => ({
  tournamentInfoRepository: {},
}));
mock.module('../../src/services/tournament-seed.service', () => ({
  ensureKnockoutRoundOneSeeded: mock(async () => {}),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

const { createEntryInfoRepository } = await import('../../src/repositories/entry-infos');
const { syncEventLives } = await import('../../src/services/event-lives.service');
const { syncKnockoutForTournament } = await import(
  '../../src/services/tournament-knockout-results.service'
);

const dialect = new PgDialect();
function renderSetFragment(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

describe('upsertFromSummary (M7: last_* computed in SQL, no read-modify-write)', () => {
  const summary = {
    id: 42,
    name: 'Alpha FC',
    player_first_name: 'Ada',
    player_last_name: 'Lovelace',
    player_region_name: 'England',
    started_event: 1,
    summary_overall_points: 1234,
    summary_overall_rank: 555,
    last_deadline_value: 1010,
    value: 1005,
    last_deadline_bank: 33,
    bank: 30,
    last_deadline_total_transfers: 12,
  } as unknown as RawFPLEntrySummary;

  const row = { id: 42, entryName: 'Alpha FC' } as unknown as DbEntryInfo;

  function buildFakeDb() {
    const returning = mock(async () => [row]);
    const onConflictDoUpdate = mock((_config: unknown) => ({ returning }));
    const values = mock((_insert: unknown) => ({ onConflictDoUpdate }));
    const insert = mock((_table: unknown) => ({ values }));
    const select = mock(() => {
      throw new Error('SELECT must not run: read-modify-write deleted');
    });
    return { db: { insert, select }, returning, onConflictDoUpdate, values, select };
  }

  let fake: ReturnType<typeof buildFakeDb>;
  beforeEach(() => {
    fake = buildFakeDb();
  });

  it('issues a single INSERT without any prior SELECT', async () => {
    const repo = createEntryInfoRepository(fake.db as never);
    const result = await repo.upsertFromSummary(summary, 7);

    expect(fake.select).not.toHaveBeenCalled();
    expect(fake.values).toHaveBeenCalledTimes(1);
    expect(fake.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(result).toEqual(row);
  });

  it('keeps insert-path last_* at zero/null and seeds usedEntryNames with the current name', async () => {
    const repo = createEntryInfoRepository(fake.db as never);
    await repo.upsertFromSummary(summary, 7);

    const insert = fake.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insert.lastBank).toBe(0);
    expect(insert.lastOverallPoints).toBe(0);
    expect(insert.lastOverallRank).toBe(0);
    expect(insert.lastTeamValue).toBe(0);
    expect(insert.lastEntryName).toBeNull();
    expect(insert.usedEntryNames).toEqual(['Alpha FC']);
    expect(insert.bank).toBe(33);
    expect(insert.teamValue).toBe(1010);
    expect(insert.lastEventId).toBe(7);
  });

  it('keeps lastEventId null when no current event is known (does not materialize 0)', async () => {
    const repo = createEntryInfoRepository(fake.db as never);
    await repo.upsertFromSummary(summary, null);

    const insert = fake.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insert.lastEventId).toBeNull();
    // Update path still COALESCE(excluded, existing, 0) so null excluded preserves existing
    const config = fake.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(renderSetFragment(config.set.lastEventId)).toContain('COALESCE(excluded.last_event_id');
  });

  it('computes last_* from the pre-update row inside onConflictDoUpdate', async () => {
    const repo = createEntryInfoRepository(fake.db as never);
    await repo.upsertFromSummary(summary, 7);

    const config = fake.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    const { set } = config;

    expect(set.entryName).toBe('Alpha FC');
    expect(renderSetFragment(set.lastBank)).toContain('COALESCE("entry_infos"."bank", 0)');
    expect(renderSetFragment(set.lastOverallPoints)).toContain(
      'COALESCE("entry_infos"."overall_points", 0)',
    );
    expect(renderSetFragment(set.lastOverallRank)).toContain(
      'COALESCE("entry_infos"."overall_rank", 0)',
    );
    expect(renderSetFragment(set.lastTeamValue)).toContain(
      'COALESCE("entry_infos"."team_value", 0)',
    );
    expect(renderSetFragment(set.lastEntryName)).toContain('"entry_infos"."entry_name"');
  });

  it('coalesces excluded-vs-existing for bank/teamValue/lastEventId and merges names in SQL', async () => {
    const repo = createEntryInfoRepository(fake.db as never);
    await repo.upsertFromSummary(summary, 7);

    const config = fake.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    const { set } = config;

    expect(renderSetFragment(set.bank)).toContain('COALESCE(excluded.bank, "entry_infos"."bank")');
    expect(renderSetFragment(set.teamValue)).toContain(
      'COALESCE(excluded.team_value, "entry_infos"."team_value")',
    );
    expect(renderSetFragment(set.lastEventId)).toContain(
      'COALESCE(excluded.last_event_id, "entry_infos"."last_event_id", 0)',
    );

    const usedNames = renderSetFragment(set.usedEntryNames);
    expect(usedNames).toContain('WITH ORDINALITY');
    expect(usedNames).toContain('excluded.used_entry_names');
    expect(usedNames).toContain('IS DISTINCT FROM');
    expect(usedNames).toMatch(/name <> ''/);
  });
});

describe('syncEventLives (M5: lives + explains upsert in one transaction)', () => {
  beforeEach(() => {
    txLivesUpsertBatch.mockClear();
    txExplainsUpsertBatch.mockClear();
    createEventLiveRepository.mockClear();
    createEventLiveExplainsRepository.mockClear();
    eventLivesCacheSet.mockClear();
    txExplainsUpsertBatch.mockImplementation(async (rows: unknown[]) => rows);
  });

  it('runs both upserts on the same transaction handle before touching cache', async () => {
    const tx = { tag: 'tx-event-lives' };
    const transaction = mock(async (cb: TxCallback) => cb(tx));
    currentDb = { transaction };
    activeTx = tx;

    const result = await syncEventLives(15);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(createEventLiveRepository).toHaveBeenCalledTimes(1);
    expect(createEventLiveExplainsRepository).toHaveBeenCalledTimes(1);
    expect(createEventLiveRepository.mock.calls[0]?.[0]).toBe(tx);
    expect(createEventLiveExplainsRepository.mock.calls[0]?.[0]).toBe(tx);
    expect(txLivesUpsertBatch).toHaveBeenCalledTimes(1);
    expect(txExplainsUpsertBatch).toHaveBeenCalledTimes(1);
    expect(eventLivesCacheSet).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ count: 1, errors: 0 });
  });

  it('propagates an explains failure and never updates the cache', async () => {
    const tx = { tag: 'tx-event-lives-fail' };
    currentDb = { transaction: mock(async (cb: TxCallback) => cb(tx)) };
    activeTx = tx;
    txExplainsUpsertBatch.mockImplementation(async () => {
      throw new Error('explains upsert failed');
    });

    await expect(syncEventLives(15)).rejects.toThrow('explains upsert failed');
    expect(eventLivesCacheSet).not.toHaveBeenCalled();
  });
});

describe('syncKnockoutForTournament (M6: four dependent upserts in one transaction)', () => {
  const tournament = {
    id: 100,
    knockoutStartedEventId: 5,
    knockoutEndedEventId: 9,
  } as unknown as TournamentSyncContext;

  beforeEach(() => {
    knockoutCallLog.length = 0;
    txResultsUpsertBatch.mockClear();
    txKnockoutsUpsertBatch.mockClear();
    createTournamentKnockoutResultsRepository.mockClear();
    createTournamentKnockoutsRepository.mockClear();
    singletonResultsFindByMatchIds.mockClear();
    txResultsFindByMatchIds.mockClear();
    txKnockoutsFindByEndedEvent.mockClear();
    txKnockoutsFindByRound.mockClear();
  });

  it('wraps all four upserts and their dependent reads in a single transaction', async () => {
    const tx = { tag: 'tx-knockout' };
    const transaction = mock(async (cb: TxCallback) => cb(tx));
    currentDb = { transaction };

    const result = await syncKnockoutForTournament(tournament, 5);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(createTournamentKnockoutResultsRepository).toHaveBeenCalledTimes(1);
    expect(createTournamentKnockoutsRepository).toHaveBeenCalledTimes(1);
    expect(createTournamentKnockoutResultsRepository.mock.calls[0]?.[0]).toBe(tx);
    expect(createTournamentKnockoutsRepository.mock.calls[0]?.[0]).toBe(tx);

    // Four upserts in dependency order; all reads served by tx-scoped repos
    expect(knockoutCallLog).toEqual(['results', 'knockouts', 'knockouts', 'results']);
    expect(singletonResultsFindByMatchIds).not.toHaveBeenCalled();
    expect(txResultsFindByMatchIds).toHaveBeenCalledTimes(2);
    expect(txKnockoutsFindByEndedEvent).toHaveBeenCalledTimes(1);
    expect(txKnockoutsFindByRound).toHaveBeenCalledTimes(1);

    // Winner of match 1 (entry 11) is seeded into the next-round home slot
    const nextRoundUpsert = txKnockoutsUpsertBatch.mock.calls[1]?.[0] as Array<{
      matchId: number;
      homeEntryId: number | null;
    }>;
    expect(nextRoundUpsert[0]).toMatchObject({ matchId: 3, homeEntryId: 11 });

    expect(result).toEqual({ updatedResults: 1, updatedKnockouts: 1, skipped: 0 });
  });

  it('rolls the whole chain back when any upsert fails', async () => {
    const tx = { tag: 'tx-knockout-fail' };
    currentDb = { transaction: mock(async (cb: TxCallback) => cb(tx)) };
    txKnockoutsUpsertBatch.mockImplementationOnce(async () => {
      throw new Error('knockouts upsert failed');
    });

    await expect(syncKnockoutForTournament(tournament, 5)).rejects.toThrow(
      'knockouts upsert failed',
    );
    // First upsert ran, second failed, the two next-round upserts never ran
    expect(knockoutCallLog).toEqual(['results']);
  });
});
