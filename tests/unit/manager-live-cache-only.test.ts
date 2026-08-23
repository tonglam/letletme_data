import { beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { fplClient } from '../../src/clients/fpl';
import { eventRepository } from '../../src/repositories/events';
import { managerScoreCheckpointRepository } from '../../src/repositories/live-window';
import { seasonRepository } from '../../src/repositories/seasons';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const dispatchModule = await import('../../src/services/manager-live-refresh-dispatch');

const redisRows = new Map<number, string>();
let redisReadFails = false;
let postgresRows: Array<Record<string, unknown>> = [];

spyOn(seasonRepository, 'findCurrent').mockImplementation(async () => TEST_SEASON as never);
spyOn(eventRepository, 'findById').mockImplementation(
  async () =>
    ({
      id: 1,
      finished: false,
      dataChecked: false,
      dataCheckedAt: null,
    }) as never,
);
spyOn(redisSingleton, 'getClient').mockImplementation(
  async () =>
    ({
      hmget: async (_key: string, ...fields: string[]) =>
        redisReadFails
          ? Promise.reject(new Error('cache unavailable'))
          : fields.map((field) => redisRows.get(Number(field)) ?? null),
    }) as never,
);
spyOn(managerScoreCheckpointRepository, 'findByScopeAndEntryIds').mockImplementation(
  async () => postgresRows as never,
);
const dispatchRefresh = spyOn(dispatchModule, 'dispatchManagerLiveRefresh').mockImplementation(
  async () => undefined,
);
const getEntrySummary = spyOn(fplClient, 'getEntrySummary').mockImplementation(async () => {
  throw new Error('CACHE_ONLY must not call FPL entry summary');
});
const getClassicStandings = spyOn(fplClient, 'getLeagueClassicStandings').mockImplementation(
  async () => {
    throw new Error('CACHE_ONLY must not call FPL standings');
  },
);

const { resolveManagerLiveScores } = await import('../../src/services/manager-live.service');
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
  upstreamUpdatedAt: null,
});

describe('manager live CACHE_ONLY reads', () => {
  beforeEach(() => {
    redisRows.clear();
    redisReadFails = false;
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
