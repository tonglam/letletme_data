import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { fplClient } from '../../src/clients/fpl';
import { MANAGER_LIVE_CLASSIC_CAPPED_CURSOR } from '../../src/domain/manager-live-refresh';
import { eventRepository } from '../../src/repositories/events';
import { managerScoreCheckpointRepository } from '../../src/repositories/live-window';
import { seasonRepository } from '../../src/repositories/seasons';
import { eventLiveManagerScoreService } from '../../src/services/event-live-manager-scores.service';
import { contentHash } from '../../src/utils/content-hash';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const dispatchModule = await import('../../src/services/manager-live-refresh-dispatch');

const redisRows = new Map<number, string>();
const materializationPointers = new Map<number, string>();
const materializationPayloads = new Map<string, string>();
let redisReadFails = false;
let redisWriteSucceeds = false;
let postgresRows: Array<Record<string, unknown>> = [];
let availableEventLiveEntryIds: Set<number> | null = null;

const loadEventLiveManagerScores = mock(
  async (_season: typeof TEST_SEASON, eventId: number, entryIds: readonly number[]) => {
    const availableEntryIds = entryIds.filter(
      (entryId) => availableEventLiveEntryIds?.has(entryId) ?? true,
    );
    if (availableEntryIds.length === 0) return null;
    const metadataByEntry = new Map<number, Record<string, unknown>>();
    for (const entryId of availableEntryIds) {
      const redisValue = redisRows.get(entryId);
      if (redisValue) metadataByEntry.set(entryId, JSON.parse(redisValue));
      const postgresValue = postgresRows.find((row) => row.entryId === entryId);
      if (postgresValue && !metadataByEntry.has(entryId))
        metadataByEntry.set(entryId, postgresValue);
    }
    const checkedAt =
      [...metadataByEntry.values()]
        .map((row) => row.checkedAt)
        .filter((value): value is string => typeof value === 'string')
        .sort()[0] ?? new Date().toISOString();
    return {
      season: TEST_SEASON.seasonCode,
      eventId,
      state: 'live' as const,
      revision: 'fpl:live:test-publication:8',
      publicationId: 'test-publication',
      checkedAt,
      sourceCheckedAt: checkedAt,
      calculationMode: 'PROJECTED_AUTOSUBS',
      algorithmVersion: 'fpl-projected-autosubs-v1',
      scores: new Map(
        availableEntryIds.map((entryId) => {
          const metadata = metadataByEntry.get(entryId);
          const eventPoints =
            typeof metadata?.eventPoints === 'number' ? metadata.eventPoints : entryId % 100;
          const netEventPoints =
            typeof metadata?.netEventPoints === 'number' ? metadata.netEventPoints : eventPoints;
          const totalPoints =
            typeof metadata?.totalPoints === 'number' ? metadata.totalPoints : 1000 + entryId;
          return [
            entryId,
            {
              entryId,
              eventPoints,
              netEventPoints,
              totalPoints,
              transferCost: 0,
              picksCheckedAt: checkedAt,
              revision: `fpl:live:test-publication:8:entry:${entryId}`,
            },
          ] as const;
        }),
      ),
    };
  },
);
eventLiveManagerScoreService.load = loadEventLiveManagerScores as never;

const effectiveLineup = (entryId: number) =>
  Array.from({ length: 15 }, (_, index) => {
    const position = index + 1;
    return {
      elementId: entryId * 100 + position,
      position,
      sourceMultiplier: position === 1 ? 2 : position <= 11 ? 1 : 0,
      effectiveMultiplier: position === 1 ? 2 : position <= 11 ? 1 : 0,
      pickActive: position <= 11,
      autoSub: false,
      isCaptain: position === 1,
      isViceCaptain: position === 2,
      captainForScoring: position === 1,
    };
  });

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
    hmget: async (key: string, ...fields: string[]) => {
      if (redisReadFails) return Promise.reject(new Error('cache unavailable'));
      if (key === 'ManagerScoreHead:2627:1:PROJECTED_AUTOSUBS') {
        return fields.map((field) => materializationPointers.get(Number(field)) ?? null);
      }
      return fields.map((field) => redisRows.get(Number(field)) ?? null);
    },
    mget: async (...keys: string[]) => keys.map((key) => materializationPayloads.get(key) ?? null),
    multi: () => transaction,
  } as never;
});
redisSingleton.getClient = getRedisClient;
const findCheckpointRows = mock(async () => postgresRows as never);
managerScoreCheckpointRepository.findByScopeAndEntryIds = findCheckpointRows;
const successfulCheckpointWrite = async (...args: unknown[]): Promise<number> =>
  Array.isArray(args[3]) ? args[3].length : 0;
const upsertCheckpoint = mock(successfulCheckpointWrite);
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
  eventLiveManagerScoreService.load = loadEventLiveManagerScores as never;
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
  totalScope: 'OVERALL' as const,
  eventRank: 10 + entryId,
  overallRank: 100 + entryId,
  leagueRank: null,
  source: 'FPL_ENTRY_SUMMARY' as const,
  transferCost: 0,
  eventPointSemantics: 'GROSS' as const,
  revision: `revision-${entryId}`,
  checkedAt,
  revisionAt: checkedAt,
  upstreamUpdatedAt: null,
  staleAt: new Date(Date.parse(checkedAt) + 90_000).toISOString(),
});

const putProjectedMaterialization = (
  entryId: number,
  checkedAt: string,
  generation = 1,
  verifiedLiveCheckedAt = checkedAt,
): void => {
  const inputRevision = `input-${entryId}`;
  const key = `ManagerScoreMaterialization:2627:1:${entryId}:${inputRevision}`;
  materializationPointers.set(
    entryId,
    JSON.stringify({ inputRevision, generation, verifiedLiveCheckedAt }),
  );
  const lineup = effectiveLineup(entryId);
  const eventPoints = entryId % 100;
  const totalPoints = 1000 + entryId;
  const scoreRevision = contentHash({
    inputRevision,
    eventPoints,
    netEventPoints: eventPoints,
    totalPoints,
    effectiveLineup: lineup,
  });
  materializationPayloads.set(
    key,
    JSON.stringify({
      entryId,
      inputRevision,
      scoreRevision,
      generation,
      calculationMode: 'PROJECTED_AUTOSUBS',
      algorithmVersion: 'fpl-projected-autosubs-v1',
      scoreSource: 'FPL_EVENT_LIVE',
      livePublicationId: '00000000-0000-4000-8000-000000000001',
      liveRevision: '8',
      liveCheckedAt: checkedAt,
      verifiedLiveCheckedAt,
      picksRevision: `picks-${entryId}`,
      picksCheckedAt: checkedAt,
      previousTotalsRevision: `previous-${entryId}`,
      previousTotalsThroughEventId: null,
      eventPoints,
      netEventPoints: eventPoints,
      totalPoints,
      transferCost: 0,
      effectiveLineup: lineup,
      rankRevision: null,
      rankSource: null,
      rankCheckedAt: null,
    }),
  );
};

describe('manager live CACHE_ONLY reads', () => {
  beforeEach(() => {
    reattachManagerLiveSpies();
    redisRows.clear();
    materializationPointers.clear();
    materializationPayloads.clear();
    redisReadFails = false;
    redisWriteSucceeds = false;
    postgresRows = [];
    availableEventLiveEntryIds = null;
    dispatchRefresh.mockClear();
    getEntrySummary.mockClear();
    getClassicStandings.mockClear();
  });

  test('never calls FPL and keeps a stale projected materialization as last-good', async () => {
    const checkedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    putProjectedMaterialization(101, checkedAt);
    putProjectedMaterialization(102, checkedAt);

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

  test('reports projected materialization and unavailable coverage precisely', async () => {
    const checkedAt = new Date().toISOString();
    putProjectedMaterialization(101, checkedAt);
    putProjectedMaterialization(102, checkedAt);
    const projected = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101, 102],
      readMode: 'CACHE_ONLY',
    });
    expect(projected).toMatchObject({
      dataAvailability: 'FRESH',
      servedFrom: 'REDIS',
      partial: false,
    });

    materializationPointers.delete(102);
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

    materializationPointers.clear();
    materializationPayloads.clear();
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
      errorCode: 'INPUT_INCOMPLETE',
    });
    expect(getEntrySummary).not.toHaveBeenCalled();
    expect(getClassicStandings).not.toHaveBeenCalled();
  });

  test('returns a 500-entry cache hit inside the 250ms service budget', async () => {
    const checkedAt = new Date().toISOString();
    const entryIds = Array.from({ length: 500 }, (_, index) => 10_000 + index);
    for (const entryId of entryIds) {
      putProjectedMaterialization(entryId, checkedAt);
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
    putProjectedMaterialization(101, checkedAt);
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
    putProjectedMaterialization(101, checkedAt);
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
    putProjectedMaterialization(101, checkedAt);
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

  test('accepts the generation-pinned immutable materialization', async () => {
    const checkedAt = new Date().toISOString();
    putProjectedMaterialization(101, checkedAt, 7);

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'CACHE_ONLY',
    });

    expect(result).toMatchObject({ servedFrom: 'REDIS', dataAvailability: 'FRESH' });
    expect(result.rows[0]).toMatchObject({
      source: 'FPL_EVENT_LIVE',
      calculationMode: 'PROJECTED_AUTOSUBS',
      eventPoints: 1,
      totalPoints: 1101,
      provenance: {
        scoreSource: 'FPL_EVENT_LIVE',
        scoreRevision: contentHash({
          inputRevision: 'input-101',
          eventPoints: 1,
          netEventPoints: 1,
          totalPoints: 1101,
          effectiveLineup: effectiveLineup(101),
        }),
      },
    });
  });

  test('serves the durable head heartbeat instead of the immutable materialization timestamp', async () => {
    const materializedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const verifiedAt = new Date().toISOString();
    putProjectedMaterialization(101, materializedAt, 1, verifiedAt);

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'CACHE_ONLY',
    });

    expect(result).toMatchObject({
      dataAvailability: 'FRESH',
      checkedAt: verifiedAt,
      servedFrom: 'REDIS',
    });
    expect(result.rows[0]?.provenance?.liveCheckedAt).toBe(verifiedAt);
  });

  test('does not serve a different live revision for a pinned CACHE_ONLY request', async () => {
    const checkedAt = new Date().toISOString();
    putProjectedMaterialization(101, checkedAt);

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'CACHE_ONLY',
      liveRef: {
        publicationId: '00000000-0000-4000-8000-000000000001',
        revision: '9',
      },
    });

    expect(result).toMatchObject({
      rows: [],
      missingEntryIds: [101],
      partial: true,
      errorCode: 'REVISION_UNAVAILABLE',
    });
  });
});

describe('manager live READ_THROUGH source reporting', () => {
  beforeEach(() => {
    reattachManagerLiveSpies();
    redisRows.clear();
    materializationPointers.clear();
    materializationPayloads.clear();
    redisReadFails = false;
    redisWriteSucceeds = false;
    postgresRows = [];
    availableEventLiveEntryIds = null;
    dispatchRefresh.mockClear();
    getEntrySummary.mockReset();
    getEntrySummary.mockImplementation(async () => {
      throw new Error('unexpected FPL request');
    });
    upsertCheckpoint.mockReset();
    upsertCheckpoint.mockImplementation(successfulCheckpointWrite);
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

  test('keeps the event-live score available when rank metadata cannot be persisted', async () => {
    getEntrySummary.mockImplementationOnce(
      async () =>
        ({
          summary_event_points: 55,
          summary_overall_points: 1_234,
          summary_event_rank: 2_345,
          summary_overall_rank: 34_567,
        }) as never,
    );
    upsertCheckpoint.mockImplementation(async () => {
      throw new Error('checkpoint unavailable');
    });

    const result = await resolveManagerLiveScores({
      eventId: 1,
      entryIds: [101],
      readMode: 'READ_THROUGH',
    });

    expect(result).toMatchObject({
      dataAvailability: 'FRESH',
      rows: [expect.objectContaining({ entryId: 101, source: 'FPL_EVENT_LIVE' })],
      missingEntryIds: [],
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
    managerScoreCheckpointRepository.upsertBatch = (async () => {
      throw new Error('checkpoint unavailable');
    }) as never;

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
    managerScoreCheckpointRepository.upsertBatch = upsertCheckpoint;
    upsertCheckpoint.mockReset();
    upsertCheckpoint.mockImplementation(successfulCheckpointWrite);
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

  test('stops at the classic page cap without refetching page 100', async () => {
    getClassicStandings.mockImplementationOnce(
      async () =>
        ({
          last_updated_data: '2026-08-23T12:00:00Z',
          standings: {
            has_next: true,
            page: 100,
            results: [{ entry: 999, event_total: 51, total: 1_051, rank: 7 }],
          },
        }) as never,
    );

    const first = await refreshClassicStandings(
      TEST_SEASON,
      1,
      99,
      new Set([101]),
      new Map(),
      null,
      { startPage: 100, maxPages: 2 },
    );
    expect(first).toMatchObject({
      complete: false,
      nextPage: MANAGER_LIVE_CLASSIC_CAPPED_CURSOR,
      errorCode: 'UPSTREAM_UNAVAILABLE',
    });

    const second = await refreshClassicStandings(
      TEST_SEASON,
      1,
      99,
      new Set([101]),
      new Map(),
      null,
      { startPage: MANAGER_LIVE_CLASSIC_CAPPED_CURSOR, maxPages: 2 },
    );
    expect(second).toMatchObject(first);
    expect(getClassicStandings).toHaveBeenCalledTimes(1);
  });

  test('accepts durable target coverage when the bounded crawl reaches the page cap', async () => {
    const checkedAt = new Date().toISOString();
    const rows = new Map([
      [101, cachedRow(101, checkedAt)],
      [102, cachedRow(102, checkedAt)],
    ]);
    getClassicStandings.mockImplementationOnce(
      async () =>
        ({
          last_updated_data: '2026-08-23T12:00:00Z',
          standings: {
            has_next: true,
            page: 100,
            results: [{ entry: 999, event_total: 51, total: 1_051, rank: 7 }],
          },
        }) as never,
    );

    const result = await refreshClassicStandings(
      TEST_SEASON,
      1,
      99,
      new Set([101, 102]),
      rows,
      null,
      { startPage: 100, maxPages: 1 },
    );

    expect(result).toMatchObject({
      complete: true,
      nextPage: MANAGER_LIVE_CLASSIC_CAPPED_CURSOR,
      errorCode: null,
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

  test('treats normal standings exhaustion as complete when earlier pages are durable', async () => {
    getClassicStandings.mockImplementationOnce(
      async () =>
        ({
          last_updated_data: '2026-08-23T12:00:00Z',
          standings: {
            has_next: false,
            page: 6,
            results: [{ entry: 999, event_total: 51, total: 1_051, rank: 7 }],
          },
        }) as never,
    );
    const checkedAt = new Date().toISOString();
    const rows = new Map([
      [101, cachedRow(101, checkedAt)],
      [102, cachedRow(102, checkedAt)],
    ]);

    const result = await refreshClassicStandings(
      TEST_SEASON,
      1,
      99,
      new Set([101, 102]),
      rows,
      null,
      { startPage: 6, maxPages: 1 },
    );

    expect(result).toMatchObject({
      complete: true,
      nextPage: 7,
      errorCode: null,
    });
  });

  test('restarts from page one when normal exhaustion misses a target', async () => {
    getClassicStandings.mockImplementationOnce(
      async () =>
        ({
          last_updated_data: '2026-08-23T12:00:00Z',
          standings: {
            has_next: false,
            page: 6,
            results: [{ entry: 999, event_total: 51, total: 1_051, rank: 7 }],
          },
        }) as never,
    );

    const result = await refreshClassicStandings(
      TEST_SEASON,
      1,
      99,
      new Set([101]),
      new Map(),
      null,
      { startPage: 6, maxPages: 1 },
    );

    expect(result).toMatchObject({
      complete: false,
      nextPage: 1,
      errorCode: 'UPSTREAM_UNAVAILABLE',
    });
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
    // The publication gate attempts the checkpoint once, then retries directly
    // when Redis is unavailable.  This case is specifically asserting that
    // neither durable attempt succeeded, so fail every checkpoint write rather
    // than only the first call (which would exercise the intentional fallback).
    upsertCheckpoint.mockImplementation(async () => {
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
      refreshedEntryIds: [],
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

    expect(standings).toEqual({
      complete: true,
      nextPage: 7,
      errorCode: null,
      refreshedEntryIds: [],
    });
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
    expect(selectWorkerSummaryRefreshTargets([25, 1, 13], 1, 0)).toEqual([1]);
    expect(selectWorkerSummaryRefreshTargets([25, 1, 13], 1, 1)).toEqual([13]);
  });
});

describe('manager live API read mode contract', () => {
  beforeEach(() => {
    reattachManagerLiveSpies();
    redisRows.clear();
    redisReadFails = false;
    postgresRows = [];
    availableEventLiveEntryIds = null;
    dispatchRefresh.mockReset();
    dispatchRefresh.mockImplementation(async () => undefined);
    getEntrySummary.mockClear();
    getClassicStandings.mockClear();
  });

  test('accepts CACHE_ONLY and returns the additive metadata', async () => {
    const checkedAt = new Date().toISOString();
    putProjectedMaterialization(101, checkedAt);
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
