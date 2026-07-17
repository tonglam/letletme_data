import { afterEach, describe, expect, mock, test } from 'bun:test';

import { fplClient } from '../../src/clients/fpl';
import { toDbChip, toNullableDbChip } from '../../src/domain/chips';
import { FPLClientError } from '../../src/utils/errors';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
  });
});

describe('FPL boundary schemas (FP-04)', () => {
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
