import { afterEach, describe, expect, mock, test } from 'bun:test';

import { FixtureSchema, TeamSchema, fplClient } from '../../src/clients/fpl';
import { toDbChip, toNullableDbChip } from '../../src/domain/chips';
import { FPLClientError } from '../../src/utils/errors';
import { buildCoreSnapshotFixture } from '../fixtures/core-snapshot.fixtures';
import { preseasonRawFPLFixture } from '../fixtures/fixtures.fixtures';
import { preseasonRawTeamFixture } from '../fixtures/teams.fixtures';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('FPL bootstrap edge-cache control', () => {
  test('adds an explicit caller cache bucket without changing the endpoint path', async () => {
    const payload = buildCoreSnapshotFixture({ playerCount: 1 }).bootstrap;
    let requestedUrl = '';
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;

    await fplClient.getBootstrap({ edgeCacheKey: 'price-changes-123' });

    const parsed = new URL(requestedUrl);
    expect(parsed.pathname).toBe('/api/bootstrap-static/');
    expect(parsed.searchParams.get('letletme_cache_bucket')).toBe('price-changes-123');
  });

  test('returns the exact validated provider bytes for immutable archiving', async () => {
    const payload = buildCoreSnapshotFixture({ playerCount: 1 }).bootstrap;
    const raw = ` ${JSON.stringify(payload)}\n`;
    globalThis.fetch = mock(
      async () =>
        new Response(raw, {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    ) as unknown as typeof fetch;

    const artifact = await fplClient.getBootstrapArtifact();

    expect(new TextDecoder().decode(artifact.bytes)).toBe(raw);
    expect(artifact.contentType).toBe('application/json');
    expect(artifact.payload.elements).toHaveLength(1);
    expect(artifact.sourceUrl).toBe('https://fantasy.premierleague.com/api/bootstrap-static/');
    expect(artifact.retrievedAt).toBeInstanceOf(Date);
  });

  test('refuses to archive a bootstrap response without the JSON media type', async () => {
    const payload = buildCoreSnapshotFixture({ playerCount: 1 }).bootstrap;
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(fplClient.getBootstrapArtifact()).rejects.toThrow(/content type/i);
  });
});

const eventLiveStats = {
  minutes: 0,
  goals_scored: 0,
  assists: 0,
  clean_sheets: 0,
  goals_conceded: 0,
  own_goals: 0,
  penalties_saved: 0,
  penalties_missed: 0,
  yellow_cards: 0,
  red_cards: 0,
  saves: 0,
  bonus: 0,
  bps: 0,
  influence: '0.0',
  creativity: '0.0',
  threat: '0.0',
  ict_index: '0.0',
  starts: 0,
  expected_goals: '0.00',
  expected_assists: '0.00',
  expected_goal_involvements: '0.00',
  expected_goals_conceded: '0.00',
  total_points: 0,
  in_dreamteam: false,
};

const picksEntryHistory = {
  event: 1,
  points: 50,
  total_points: 50,
  rank: 1000,
  overall_rank: 1000,
  bank: 0,
  value: 1000,
  event_transfers: 0,
  event_transfers_cost: 0,
  points_on_bench: 0,
};

const picksItems = [
  { element: 1, position: 1, multiplier: 1, is_captain: false, is_vice_captain: false },
];

describe('FPL entry cup client', () => {
  test('returns null when an entry has no cup data', async () => {
    globalThis.fetch = mock(
      async () => new Response(null, { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(fplClient.getEntryCup(123)).resolves.toBeNull();
  });

  test('continues to throw upstream failures', async () => {
    // FP-18: 5xx now retries with backoff — keep the waits at milliseconds.
    process.env.FPL_RETRY_BASE_DELAY_MS = '1';
    try {
      globalThis.fetch = mock(
        async () => new Response(null, { status: 503, statusText: 'Service Unavailable' }),
      ) as unknown as typeof fetch;

      try {
        await fplClient.getEntryCup(123);
        throw new Error('Expected getEntryCup to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(FPLClientError);
        expect((error as FPLClientError).status).toBe(503);
      }
    } finally {
      delete process.env.FPL_RETRY_BASE_DELAY_MS;
    }
  });
});

describe('FPL boundary schemas (FP-04)', () => {
  test('accepts the 26/27 preseason placeholders without coercion', () => {
    const team = TeamSchema.parse(preseasonRawTeamFixture);
    const fixture = FixtureSchema.parse(preseasonRawFPLFixture);

    expect(team.position).toBe(0);
    expect(team.strength).toBeNull();
    expect(fixture.pulse_id).toBe(0);
  });

  test('getEventLive tolerates elements with explain: null', async () => {
    const payload = {
      elements: [
        { id: 101, stats: eventLiveStats, explain: null },
        {
          id: 102,
          stats: { ...eventLiveStats, total_points: 7 },
          explain: [{ fixture: 1, stats: [{ identifier: 'total_points', value: 7, points: 7 }] }],
        },
      ],
    };
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await fplClient.getEventLive(1);
    expect(result.elements).toHaveLength(2);
    expect(result.elements[0]?.explain).toBeNull();
    expect(result.elements[1]?.id).toBe(102);
  });

  test('getEntryEventPicks accepts the manager chip', async () => {
    const payload = {
      active_chip: 'manager',
      automatic_subs: [],
      entry_history: picksEntryHistory,
      picks: picksItems,
    };
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await fplClient.getEntryEventPicks(123, 1);
    expect(result.active_chip).toBe('manager');
  });

  test('getEntryEventPicks passes unknown future chips through', async () => {
    const payload = {
      active_chip: 'superchip-2049',
      automatic_subs: [],
      entry_history: picksEntryHistory,
      picks: picksItems,
    };
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await fplClient.getEntryEventPicks(123, 1);
    expect(result.active_chip).toBe('superchip-2049');
  });

  test('getEntryEventPicks still accepts null chips', async () => {
    const payload = {
      active_chip: null,
      automatic_subs: [],
      entry_history: picksEntryHistory,
      picks: picksItems,
    };
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await fplClient.getEntryEventPicks(123, 1);
    expect(result.active_chip).toBeNull();
  });

  test('getEntryEventPicks rejects malformed automatic substitutions', async () => {
    const payload = {
      active_chip: null,
      automatic_subs: [{ entry: 123, element_out: 101, event: 1 }],
      entry_history: picksEntryHistory,
      picks: picksItems,
    };
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(fplClient.getEntryEventPicks(123, 1)).rejects.toThrow();
  });

  test('classic standings retain preseason new entries and both pagination cursors', async () => {
    let requestedUrl = '';
    const payload = {
      league: {
        id: 8863,
        name: 'Classic League',
        start_event: 1,
        scoring: 'c',
      },
      standings: { has_next: false, page: 1, results: [] },
      new_entries: {
        has_next: true,
        page: 2,
        results: [
          {
            entry: 7819,
            entry_name: 'Preseason Team',
            player_first_name: 'Preseason',
            player_last_name: 'Manager',
          },
        ],
      },
    };
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fplClient.getLeagueClassicStandings(8863, 1, 2);

    expect(requestedUrl).toContain('page_standings=1');
    expect(requestedUrl).toContain('page_new_entries=2');
    expect(result.league?.start_event).toBe(1);
    expect(result.new_entries?.results[0]?.entry).toBe(7819);
  });

  test('H2H standings accept the official Average Team placeholder', async () => {
    const payload = {
      league: { id: 34879, name: 'H2H', start_event: 1, scoring: 'h' },
      standings: {
        has_next: false,
        page: 1,
        results: [
          {
            entry: null,
            entry_name: 'AVERAGE',
            player_name: 'AVERAGE',
            rank: 1,
            total: 0,
            matches_played: 0,
            matches_won: 0,
            matches_drawn: 0,
            matches_lost: 0,
            points_for: 0,
          },
        ],
      },
      new_entries: { has_next: false, page: 1, results: [] },
    };
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(payload), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await fplClient.getLeagueH2HStandings(34879, 1);

    expect(result.standings.results[0]?.entry).toBeNull();
  });
});

describe('chip mapping at the DB boundary', () => {
  test('maps known chips through unchanged', () => {
    for (const chip of ['wildcard', 'freehit', 'bboost', '3xc', 'manager'] as const) {
      expect(toDbChip(chip)).toBe(chip);
      expect(toNullableDbChip(chip)).toBe(chip);
    }
  });

  test('maps null and empty chips to the DB defaults', () => {
    expect(toDbChip(null)).toBe('n/a');
    expect(toDbChip(undefined)).toBe('n/a');
    expect(toDbChip('')).toBe('n/a');
    expect(toNullableDbChip(null)).toBeNull();
    expect(toNullableDbChip(undefined)).toBeNull();
    expect(toNullableDbChip('')).toBeNull();
  });

  test('passes unknown chips through instead of rejecting', () => {
    const unknown: string = 'superchip-2049';
    expect(toDbChip(unknown) as string).toBe('superchip-2049');
    expect(toNullableDbChip(unknown) as string).toBe('superchip-2049');
  });
});
