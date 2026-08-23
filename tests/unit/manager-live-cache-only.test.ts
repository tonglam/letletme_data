import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { fplClient } from '../../src/clients/fpl';
import { eventRepository } from '../../src/repositories/events';
import { managerScoreCheckpointRepository } from '../../src/repositories/live-window';
import { seasonRepository } from '../../src/repositories/seasons';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const dispatchModule = await import('../../src/services/manager-live-refresh-dispatch');

const redisRows = new Map<number, string>();
let redisReadFails = false;
let redisWriteSucceeds = false;
let postgresRows: Array<Record<string, unknown>> = [];

const findCurrent = mock(async () => TEST_SEASON as never);
seasonRepository.findCurrent = findCurrent;
const findEventById = mock(
  async () =>
    ({
      id: 1,
      finished: false,
      dataChecked: false,
      dataCheckedAt: null,
    }) as never,
);
eventRepository.findById = findEventById;
const getRedisClient = mock(async () => {
  const transaction = {
    hset: () => transaction,
    expire: () => transaction,
    exec: async () =>
      redisWriteSucceeds
        ? ([[null, 1]] as const)
        : ([[new Error('cache write unavailable'), null]] as const),
  };
  return {
    hmget: async (_key: string, ...fields: string[]) =>
      redisReadFails
        ? Promise.reject(new Error('cache unavailable'))
        : fields.map((field) => redisRows.get(Number(field)) ?? null),
    multi: () => transaction,
  } as never;
});
redisSingleton.getClient = getRedisClient;
const findCheckpointRows = mock(async () => postgresRows as never);
managerScoreCheckpointRepository.findByScopeAndEntryIds = findCheckpointRows;
const upsertCheckpoint = mock(async (..._args: unknown[]) => undefined);
managerScoreCheckpointRepository.upsertBatch = upsertCheckpoint;
const dispatchRefresh = spyOn(dispatchModule, 'dispatchManagerLiveRefresh').mockImplementation(
  async () => undefined,
);
const getEntrySummary = mock(async () => {
  throw new Error('CACHE_ONLY must not call FPL entry summary');
});
fplClient.getEntrySummary = getEntrySummary;
const getClassicStandings = mock(async (..._args: unknown[]) => {
  throw new Error('CACHE_ONLY must not call FPL standings');
});
fplClient.getLeagueClassicStandings = getClassicStandings;

// A few legacy unit files call bun:test's global mock.restore() in afterEach.
// Bun 1.2 can run those files in the same process, so reattach these stable
// spies before every case; otherwise an unrelated test can restore one of the
// service dependencies while this contract suite is still exercising it.
const reattachManagerLiveSpies = (): void => {
  seasonRepository.findCurrent = findCurrent;
  eventRepository.findById = findEventById;
  redisSingleton.getClient = getRedisClient;
  managerScoreCheckpointRepository.findByScopeAndEntryIds = findCheckpointRows;
  managerScoreCheckpointRepository.upsertBatch = upsertCheckpoint;
  if (dispatchModule.dispatchManagerLiveRefresh !== dispatchRefresh) {
    dispatchModule.dispatchManagerLiveRefresh = dispatchRefresh;
  }
  fplClient.getEntrySummary = getEntrySummary;
  fplClient.getLeagueClassicStandings = getClassicStandings;
};

const {
  classicStandingsCursorAfterRefresh,
  enrichClassicStandingOverallRank,
  preserveClassicOverallRank,
  refreshClassicStandings,
  resolveManagerLiveScores,
  selectClassicOverallRankRefreshTargets,
  selectWorkerSummaryRefreshTargets,
  selectWorkerClassicFallbackTargets,
} = await import('../../src/services/manager-live.service');
const { managerLiveAPI } = await import('../../src/api/manager-live.api');

const cachedRow = (entryId: number, checkedAt: string) => ({
  season: TEST_SEASON.seasonCode,
  eventId: 1,
  entryId,
  eventPoints: entryId % 100,
  netEventPoints: entryId % 100,
  totalPoints: 1000 + entryId,
  totalScope: 'OVERALL',
  eventRank: 10 + entryId,
  overallRank: 100 + entryId,
  leagueRank: null,
  source: 'FPL_ENTRY_SUMMARY',
  transferCost: 0,
  eventPointSemantics: 'GROSS',
  revision: `revision-${entryId}`,
  checkedAt,
  revisionAt: checkedAt,
  upstreamUpdatedAt: null,
  staleAt: new Date(Date.parse(checkedAt) + 90_000).toISOString(),
});

const checkpointRow = (entryId: number, checkedAt: string) => ({
  seasonId: TEST_SEASON.seasonId,
  eventId: 1,
  scopeType: 'ENTRY',
  scopeId: 0,
  entryId,
  eventPoints: entryId % 100,
  netEventPoints: entryId % 100,
  totalPoints: 1000 + entryId,
  totalScope: 'OVERALL',
  eventRank: 10 + entryId,
  overallRank: 100 + entryId,
  leagueRank: null,
  source: 'FPL_ENTRY_SUMMARY',
  transferCost: 0,
  eventPointSemantics: 'GROSS',
  contentRevision: `revision-${entryId}`,
  checkedAt: new Date(checkedAt),
  updatedAt: new Date(checkedAt),
  upstreamUpdatedAt: null,
});

describe('manager live CACHE_ONLY reads', () => {
  beforeEach(() => {
    reattachManagerLiveSpies();
    redisRows.clear();
    redisReadFails = false;
    redisWriteSucceeds = false;
    postgresRows = [];
    dispatchRefresh.mockClear();
    getEntrySummary.mockClear();
    getClassicStandings.mockClear();
  });

  test('never calls FPL and keeps stale Redis rows as last-good', async () => {
    const checkedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    redisRows.set(101, JSON.stringify(cachedRow(101, checkedAt)));
    redisRows.set(102, JSON.stringify(cachedRow(102, checkedAt)));

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101, 102],
      readMode: 'CACHE_ONLY',
    });

    expect(result).toMatchObject({
      dataAvailability: 'LAST_GOOD',
      servedFrom: 'REDIS',
      refreshQueued: true,
      partial: false,
      missingEntryIds: [],
      checkedAt,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.managerRevision).toHaveLength(20);
    expect(dispatchRefresh).toHaveBeenCalledTimes(1);
    expect(getEntrySummary).not.toHaveBeenCalled();
    expect(getClassicStandings).not.toHaveBeenCalled();
  });

  test('reports PostgreSQL, mixed, and unavailable source coverage precisely', async () => {
    const checkedAt = new Date().toISOString();
    redisReadFails = true;
    postgresRows = [checkpointRow(101, checkedAt), checkpointRow(102, checkedAt)];
    const postgres = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101, 102],
      readMode: 'CACHE_ONLY',
    });
    expect(postgres).toMatchObject({
      dataAvailability: 'FRESH',
      servedFrom: 'POSTGRES',
      partial: false,
    });

    redisReadFails = false;
    redisRows.set(101, JSON.stringify(cachedRow(101, checkedAt)));
    postgresRows = [checkpointRow(102, checkedAt)];
    const mixed = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101, 102],
      readMode: 'CACHE_ONLY',
    });
    expect(mixed).toMatchObject({
      dataAvailability: 'FRESH',
      servedFrom: 'MIXED',
      partial: false,
    });

    postgresRows = [];
    const partial = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101, 102],
      readMode: 'CACHE_ONLY',
    });
    expect(partial).toMatchObject({
      dataAvailability: 'PARTIAL',
      servedFrom: 'REDIS',
      partial: true,
      missingEntryIds: [102],
    });

    redisRows.clear();
    const unavailable = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101, 102],
      readMode: 'CACHE_ONLY',
    });
    expect(unavailable).toMatchObject({
      dataAvailability: 'UNAVAILABLE',
      servedFrom: 'NONE',
      partial: true,
      missingEntryIds: [101, 102],
      errorCode: 'UPSTREAM_UNAVAILABLE',
    });
    expect(getEntrySummary).not.toHaveBeenCalled();
    expect(getClassicStandings).not.toHaveBeenCalled();
  });

  test('returns a 500-entry cache hit inside the 250ms service budget', async () => {
    const checkedAt = new Date().toISOString();
    const entryIds = Array.from({ length: 500 }, (_, index) => 10_000 + index);
    for (const entryId of entryIds) {
      redisRows.set(entryId, JSON.stringify(cachedRow(entryId, checkedAt)));
    }

    const startedAt = performance.now();
    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds,
      readMode: 'CACHE_ONLY',
    });
    const durationMs = performance.now() - startedAt;

    expect(result.rows).toHaveLength(500);
    expect(result.dataAvailability).toBe('FRESH');
    expect(durationMs).toBeLessThan(250);
    expect(getEntrySummary).not.toHaveBeenCalled();
    expect(getClassicStandings).not.toHaveBeenCalled();
  });

  test('does not let a stuck queue dispatch block a cache hit', async () => {
    const checkedAt = new Date().toISOString();
    redisRows.set(101, JSON.stringify(cachedRow(101, checkedAt)));
    dispatchRefresh.mockImplementationOnce(() => new Promise<void>(() => undefined));

    const startedAt = performance.now();
    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'CACHE_ONLY',
    });
    const durationMs = performance.now() - startedAt;

    expect(result.rows).toHaveLength(1);
    expect(result.refreshQueued).toBe(false);
    expect(durationMs).toBeLessThan(250);
  });

  test('does not confirm a dispatch that rejects after the response deadline', async () => {
    const checkedAt = new Date().toISOString();
    redisRows.set(101, JSON.stringify(cachedRow(101, checkedAt)));
    let rejectDispatch!: (reason: Error) => void;
    const lateDispatch = new Promise<void>((_, reject) => {
      rejectDispatch = reject;
    });
    dispatchRefresh.mockImplementationOnce(() => lateDispatch);

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'CACHE_ONLY',
    });

    expect(result.refreshQueued).toBe(false);
    rejectDispatch(new Error('queue unavailable after response deadline'));
    await lateDispatch.catch(() => undefined);
  });

  test('reports a confirmed enqueue failure without discarding cached content', async () => {
    const checkedAt = new Date().toISOString();
    redisRows.set(101, JSON.stringify(cachedRow(101, checkedAt)));
    dispatchRefresh.mockImplementationOnce(async () => {
      throw new Error('queue unavailable');
    });

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'CACHE_ONLY',
    });

    expect(result.rows).toHaveLength(1);
    expect(result.refreshQueued).toBe(false);
  });

  test('prefers a differing durable checkpoint at the same checkedAt', async () => {
    const checkedAt = new Date().toISOString();
    redisRows.set(101, JSON.stringify(cachedRow(101, checkedAt)));
    postgresRows = [
      {
        ...checkpointRow(101, checkedAt),
        overallRank: 765_432,
        contentRevision: 'postgres-durable-revision',
      },
    ];

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'CACHE_ONLY',
    });

    expect(result).toMatchObject({ servedFrom: 'POSTGRES' });
    expect(result.rows[0]).toMatchObject({
      overallRank: 765_432,
      revision: 'postgres-durable-revision',
    });
    expect(result.rows[0]).not.toHaveProperty('revisionAt');
  });

  test('keeps a newer Redis enrichment when the matching checkpoint write failed', async () => {
    const checkedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const revisionAt = new Date(Date.parse(checkedAt) + 60_000).toISOString();
    redisRows.set(
      101,
      JSON.stringify({
        ...cachedRow(101, checkedAt),
        overallRank: 123_456,
        revision: 'redis-newer-revision',
        revisionAt,
      }),
    );
    postgresRows = [
      {
        ...checkpointRow(101, checkedAt),
        overallRank: 765_432,
        contentRevision: 'postgres-older-revision',
      },
    ];

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'CACHE_ONLY',
    });

    expect(result).toMatchObject({ servedFrom: 'REDIS' });
    expect(result.rows[0]).toMatchObject({
      overallRank: 123_456,
      revision: 'redis-newer-revision',
    });
  });

  test('uses a newer checkpoint enrichment when the matching Redis write failed', async () => {
    const checkedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const revisionAt = new Date(Date.parse(checkedAt) + 60_000);
    redisRows.set(101, JSON.stringify(cachedRow(101, checkedAt)));
    postgresRows = [
      {
        ...checkpointRow(101, checkedAt),
        overallRank: 765_432,
        contentRevision: 'postgres-newer-revision',
        updatedAt: revisionAt,
      },
    ];

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'CACHE_ONLY',
    });

    expect(result).toMatchObject({ servedFrom: 'POSTGRES' });
    expect(result.rows[0]).toMatchObject({
      overallRank: 765_432,
      revision: 'postgres-newer-revision',
    });
  });
});

describe('manager live READ_THROUGH source reporting', () => {
  beforeEach(() => {
    redisRows.clear();
    redisReadFails = false;
    redisWriteSucceeds = false;
    postgresRows = [];
    dispatchRefresh.mockClear();
    getEntrySummary.mockReset();
    getEntrySummary.mockImplementation(async () => {
      throw new Error('unexpected FPL request');
    });
    upsertCheckpoint.mockReset();
    upsertCheckpoint.mockImplementation(async () => undefined);
  });

  test('does not claim Redis when an upstream row could not be persisted', async () => {
    getEntrySummary.mockImplementationOnce(
      async () =>
        ({
          summary_event_points: 55,
          summary_overall_points: 1_234,
          summary_event_rank: 2_345,
          summary_overall_rank: 34_567,
        }) as never,
    );

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'READ_THROUGH',
    });

    expect(result).toMatchObject({
      dataAvailability: 'FRESH',
      servedFrom: 'NONE',
      partial: false,
      missingEntryIds: [],
    });
    expect(getEntrySummary).toHaveBeenCalledTimes(1);
  });

  test('retries a summary when neither durable store accepted it', async () => {
    getEntrySummary.mockImplementationOnce(
      async () =>
        ({
          summary_event_points: 55,
          summary_overall_points: 1_234,
          summary_event_rank: 2_345,
          summary_overall_rank: 34_567,
        }) as never,
    );
    upsertCheckpoint.mockImplementationOnce(async () => {
      throw new Error('checkpoint unavailable');
    });

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'READ_THROUGH',
    });

    expect(result).toMatchObject({
      dataAvailability: 'UNAVAILABLE',
      rows: [],
      missingEntryIds: [101],
      errorCode: 'UPSTREAM_UNAVAILABLE',
    });
  });

  test('keeps a summary when Redis succeeded even if its checkpoint failed', async () => {
    redisWriteSucceeds = true;
    getEntrySummary.mockImplementationOnce(
      async () =>
        ({
          summary_event_points: 55,
          summary_overall_points: 1_234,
          summary_event_rank: 2_345,
          summary_overall_rank: 34_567,
        }) as never,
    );
    upsertCheckpoint.mockImplementationOnce(async () => {
      throw new Error('checkpoint unavailable');
    });

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'READ_THROUGH',
    });

    expect(result).toMatchObject({
      dataAvailability: 'FRESH',
      missingEntryIds: [],
      errorCode: null,
    });
    expect(result.rows).toHaveLength(1);
  });
});

describe('manager live classic standings convergence', () => {
  beforeEach(() => {
    upsertCheckpoint.mockReset();
    upsertCheckpoint.mockImplementation(async () => undefined);
    getClassicStandings.mockReset();
    getClassicStandings.mockImplementation(async () => {
      throw new Error('unexpected FPL standings request');
    });
  });

  test('retries a standings page after that page fails', async () => {
    getClassicStandings.mockImplementationOnce(async (_leagueId, page) => {
      expect(page).toBe(5);
      throw new Error('upstream unavailable');
    });

    const result = await refreshClassicStandings(
      TEST_SEASON,
      1,
      99,
      new Set([101]),
      new Map(),
      null,
      { startPage: 5, maxPages: 2 },
    );

    expect(result).toMatchObject({
      complete: false,
      nextPage: 5,
      errorCode: 'UPSTREAM_UNAVAILABLE',
    });
  });

  test('persists completed pages before retrying a later failed page', async () => {
    getClassicStandings.mockImplementationOnce(
      async () =>
        ({
          last_updated_data: '2026-08-23T12:00:00Z',
          standings: {
            has_next: true,
            page: 5,
            results: [{ entry: 101, event_total: 51, total: 1_051, rank: 7 }],
          },
        }) as never,
    );
    getClassicStandings.mockImplementationOnce(async () => {
      throw new Error('page six unavailable');
    });

    const rows = new Map();
    const result = await refreshClassicStandings(
      TEST_SEASON,
      1,
      99,
      new Set([101, 102]),
      rows,
      null,
      { startPage: 5, maxPages: 2 },
    );

    expect(result).toMatchObject({
      complete: false,
      nextPage: 6,
      errorCode: 'UPSTREAM_UNAVAILABLE',
    });
    expect(rows.get(101)).toMatchObject({ eventPoints: 51, leagueRank: 7 });
    expect(upsertCheckpoint).toHaveBeenCalledTimes(1);
    expect(upsertCheckpoint.mock.calls[0]?.[3]).toHaveLength(1);
  });

  test('does not advance a page when both durable publications fail', async () => {
    getClassicStandings.mockImplementationOnce(
      async () =>
        ({
          last_updated_data: '2026-08-23T12:00:00Z',
          standings: {
            has_next: true,
            page: 5,
            results: [{ entry: 101, event_total: 51, total: 1_051, rank: 7 }],
          },
        }) as never,
    );
    upsertCheckpoint.mockImplementationOnce(async () => {
      throw new Error('checkpoint unavailable');
    });

    const rows = new Map();
    const result = await refreshClassicStandings(TEST_SEASON, 1, 99, new Set([101]), rows, null, {
      startPage: 5,
      maxPages: 1,
    });

    expect(result).toEqual({
      complete: false,
      nextPage: 5,
      errorCode: 'UPSTREAM_UNAVAILABLE',
    });
    expect(rows.has(101)).toBe(false);
  });

  test('marks an empty standings pass complete so the queue clears its cursor', async () => {
    const standings = await refreshClassicStandings(
      TEST_SEASON,
      1,
      99,
      new Set(),
      new Map(),
      null,
      { startPage: 7, maxPages: 2 },
    );

    expect(standings).toEqual({ complete: true, nextPage: 7, errorCode: null });
    expect(classicStandingsCursorAfterRefresh(true, standings)).toBeNull();
    expect(getClassicStandings).not.toHaveBeenCalled();
  });
  test('does not mark old standings fresh when only overall rank is enriched', () => {
    const checkedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const existing = {
      ...cachedRow(101, checkedAt),
      source: 'FPL_CLASSIC_STANDINGS',
      totalScope: 'CLASSIC_PHASE',
      leagueRank: 8,
      overallRank: 456_789,
    };

    const enriched = enrichClassicStandingOverallRank(existing as never, 123_456);

    expect(enriched).toMatchObject({
      source: 'FPL_CLASSIC_STANDINGS',
      leagueRank: 8,
      overallRank: 123_456,
      checkedAt: existing.checkedAt,
      staleAt: existing.staleAt,
    });
    expect(enriched.revision).not.toBe(existing.revision);
    expect(Date.parse(enriched.revisionAt)).toBeGreaterThan(Date.parse(existing.revisionAt));

    const missingRank = enrichClassicStandingOverallRank(enriched, null);
    expect(missingRank.overallRank).toBe(123_456);
    expect(missingRank.checkedAt).toBe(existing.checkedAt);
  });

  test('preserves an enriched overall rank when standings refresh the phase row', () => {
    const checkedAt = new Date().toISOString();
    const existing = { ...cachedRow(101, checkedAt), overallRank: 456_789 };
    const incoming = {
      ...cachedRow(101, checkedAt),
      totalScope: 'CLASSIC_PHASE',
      source: 'FPL_CLASSIC_STANDINGS',
      overallRank: null,
      leagueRank: 8,
      revision: 'standings-without-overall-rank',
    };

    const merged = preserveClassicOverallRank(incoming as never, existing as never);

    expect(merged).toMatchObject({
      source: 'FPL_CLASSIC_STANDINGS',
      totalScope: 'CLASSIC_PHASE',
      leagueRank: 8,
      overallRank: 456_789,
    });
    expect(merged.revision).not.toBe(incoming.revision);
  });

  test('continues standings before falling back and never overwrites a classic row', () => {
    const rows = new Map([
      [101, { source: 'FPL_CLASSIC_STANDINGS' }],
      [102, { source: 'FPL_ENTRY_SUMMARY' }],
    ]);

    expect(selectWorkerClassicFallbackTargets([101, 102, 103], rows as never, false)).toEqual([]);
    expect(selectWorkerClassicFallbackTargets([101, 102, 103], rows as never, true)).toEqual([
      102, 103,
    ]);
  });

  test('rotates positive overall ranks while prioritizing missing values', () => {
    const positiveRows = new Map(
      Array.from(
        { length: 8 },
        (_, index) =>
          [index + 1, { source: 'FPL_CLASSIC_STANDINGS', overallRank: 10_000 + index }] as const,
      ),
    );

    expect(
      selectClassicOverallRankRefreshTargets([...positiveRows.keys()], positiveRows, 4, 0),
    ).toEqual([1, 2, 3, 4]);
    expect(
      selectClassicOverallRankRefreshTargets([...positiveRows.keys()], positiveRows, 4, 1),
    ).toEqual([5, 6, 7, 8]);

    const mixedRows = new Map(
      Array.from(
        { length: 10 },
        (_, index) =>
          [
            index + 1,
            {
              source: 'FPL_CLASSIC_STANDINGS',
              overallRank: index < 6 ? null : 20_000 + index,
            },
          ] as const,
      ),
    );
    expect(selectClassicOverallRankRefreshTargets([...mixedRows.keys()], mixedRows, 4, 0)).toEqual([
      1, 2, 3, 7,
    ]);
    expect(selectClassicOverallRankRefreshTargets([...mixedRows.keys()], mixedRows, 4, 1)).toEqual([
      4, 5, 6, 8,
    ]);
  });

  test('rotates bounded summary chunks past a permanently failing prefix', () => {
    const entryIds = Array.from({ length: 25 }, (_, index) => index + 1);

    expect(selectWorkerSummaryRefreshTargets(entryIds, 12, 0)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(selectWorkerSummaryRefreshTargets(entryIds, 12, 1)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 13),
    );
    expect(selectWorkerSummaryRefreshTargets(entryIds, 12, 2)).toEqual([25]);
    expect(selectWorkerSummaryRefreshTargets(entryIds, 12, 3)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });
});

describe('manager live API read mode contract', () => {
  beforeEach(() => {
    redisRows.clear();
    redisReadFails = false;
    postgresRows = [];
    dispatchRefresh.mockReset();
    dispatchRefresh.mockImplementation(async () => undefined);
    getEntrySummary.mockClear();
    getClassicStandings.mockClear();
  });

  test('accepts CACHE_ONLY and returns the additive metadata', async () => {
    const checkedAt = new Date().toISOString();
    redisRows.set(101, JSON.stringify(cachedRow(101, checkedAt)));
    const response = await managerLiveAPI.handle(
      new Request('http://localhost/internal/manager-live/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: 1, entryIds: [101], readMode: 'CACHE_ONLY' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        managerRevision: expect.any(String),
        dataAvailability: 'FRESH',
        servedFrom: 'REDIS',
        refreshQueued: true,
      },
    });
  });

  test('rejects an unknown read mode at the HTTP boundary', async () => {
    const response = await managerLiveAPI.handle(
      new Request('http://localhost/internal/manager-live/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: 1, entryIds: [101], readMode: 'NETWORK_FIRST' }),
      }),
    );
    expect(response.status).toBe(422);
  });
});
