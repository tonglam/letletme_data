import { describe, expect, it } from 'bun:test';

import type { FPLBootstrapResponse } from '../../src/clients/fpl';
import {
  normalizePriceChangeBoard,
  parsePublishedPriceChangeBoard,
  priceChangeBoardTriggerFingerprint,
  priceChangeBoardValueFingerprint,
  priceChangeBootstrapEdgeCacheKey,
  priceChangePrimaryDeadline,
  priceChangeTriggerFingerprint,
  priceChangeValueFingerprint,
  shouldPublishPriceChangeHotSnapshot,
  PriceChangePredictionValidationError,
  PRICE_CHANGE_MAX_AGE_MS,
  PRICE_CHANGE_READY_MS,
  PRICE_CHANGE_STALE_MS,
  requestPriceChangeBootstrap,
} from '../../src/services/price-change-predictions.service';

function bootstrapFixture(overrides: Record<string, unknown> = {}): FPLBootstrapResponse {
  const element = {
    id: 1,
    code: 1001,
    element_type: 3,
    team: 10,
    now_cost: 75,
    cost_change_start: 0,
    cost_change_event: 0,
    cost_change_event_fall: 0,
    cost_change_start_fall: 0,
    first_name: 'Test',
    second_name: 'Player',
    web_name: 'Player',
    photo: '1.jpg',
    status: 'a',
    selected_by_percent: '12.5',
    total_points: 0,
    points_per_game: '0.0',
    form: '0.0',
    dreamteam_count: 0,
    in_dreamteam: false,
    special: false,
    squad_number: null,
    news: '',
    news_added: null,
    chance_of_playing_this_round: null,
    chance_of_playing_next_round: null,
    value_form: '0.0',
    value_season: '0.0',
    transfers_in: 10,
    transfers_out: 4,
    transfers_in_event: 10,
    transfers_out_event: 4,
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
    expected_goals: '0.0',
    expected_assists: '0.0',
    expected_goal_involvements: '0.0',
    expected_goals_conceded: '0.0',
    price_change_percent: 2.5,
    price_change_hourly_rate: '0.25',
    price_change_projections: [{ offset: 0, projected_percent: 2.5, likelihood: 5 }],
    price_change_locked_until: null,
    price_change_calibrating: false,
    ...overrides,
  } as unknown as FPLBootstrapResponse['elements'][number];

  return {
    events: [],
    teams: [
      { id: 10, name: 'Test FC', short_name: 'TST' } as FPLBootstrapResponse['teams'][number],
    ],
    elements: [element],
    game_settings: null,
    game_config: { settings: { price_change_deadlines: ['2026-08-23T18:30:00Z'] } },
    phases: [],
    total_players: 1,
    element_stats: [],
    element_types: [],
    chips: [],
  } as FPLBootstrapResponse;
}

describe('price-change prediction normalization', () => {
  it('only changes the hot trigger when official prices or player IDs change', () => {
    const baseline = bootstrapFixture();
    const transferOnly = bootstrapFixture({ transfers_in_event: 99, transfers_out_event: 1 });
    const priceChanged = bootstrapFixture({ now_cost: 76 });

    expect(priceChangeTriggerFingerprint(transferOnly)).toBe(
      priceChangeTriggerFingerprint(baseline),
    );
    expect(priceChangeTriggerFingerprint(priceChanged)).not.toBe(
      priceChangeTriggerFingerprint(baseline),
    );

    const board = normalizePriceChangeBoard(baseline, new Date('2026-08-22T00:00:00Z'));
    expect(priceChangeBoardTriggerFingerprint(board)).toBe(priceChangeTriggerFingerprint(baseline));
    expect(priceChangeBoardValueFingerprint(board)).toBe(priceChangeValueFingerprint(baseline));
    expect(priceChangePrimaryDeadline(baseline)).toBe('2026-08-23T18:30:00.000Z');
  });

  it('keeps a deadline rollover separate from the no-change value identity', () => {
    const baseline = bootstrapFixture();
    const nextDeadline = {
      ...baseline,
      game_config: {
        settings: { price_change_deadlines: ['2026-08-24T18:30:00Z'] },
      },
    } as unknown as FPLBootstrapResponse;

    expect(priceChangeValueFingerprint(nextDeadline)).toBe(priceChangeValueFingerprint(baseline));
    expect(priceChangeTriggerFingerprint(nextDeadline)).not.toBe(
      priceChangeTriggerFingerprint(baseline),
    );
    expect(
      shouldPublishPriceChangeHotSnapshot(
        priceChangeValueFingerprint(baseline),
        priceChangeValueFingerprint(nextDeadline),
      ),
    ).toBe(false);
    expect(shouldPublishPriceChangeHotSnapshot(null, priceChangeValueFingerprint(baseline))).toBe(
      false,
    );
    expect(
      shouldPublishPriceChangeHotSnapshot(
        priceChangeValueFingerprint(baseline),
        priceChangeValueFingerprint(bootstrapFixture({ now_cost: 76 })),
      ),
    ).toBe(true);
  });

  it('rotates the official bootstrap edge-cache key once per five-minute bucket', () => {
    expect(priceChangeBootstrapEdgeCacheKey(Date.parse('2026-08-24T06:01:00Z'))).toBe(
      priceChangeBootstrapEdgeCacheKey(Date.parse('2026-08-24T06:04:59.999Z')),
    );
    expect(priceChangeBootstrapEdgeCacheKey(Date.parse('2026-08-24T06:05:00Z'))).not.toBe(
      priceChangeBootstrapEdgeCacheKey(Date.parse('2026-08-24T06:04:59.999Z')),
    );
    expect(() => priceChangeBootstrapEdgeCacheKey(Number.NaN)).toThrow(
      'requires a valid timestamp',
    );
  });

  it('retains request ordering when an older bootstrap completes last', async () => {
    const bootstrap = bootstrapFixture();
    let finishOlder: ((value: FPLBootstrapResponse) => void) | undefined;
    const olderResponse = new Promise<FPLBootstrapResponse>((resolve) => {
      finishOlder = resolve;
    });
    const olderTimes = [
      Date.parse('2026-08-24T06:04:59.900Z'),
      Date.parse('2026-08-24T06:05:10.000Z'),
    ];
    const newerTimes = [
      Date.parse('2026-08-24T06:05:00.100Z'),
      Date.parse('2026-08-24T06:05:01.000Z'),
    ];
    const requestedAt: number[] = [];

    const olderPromise = requestPriceChangeBootstrap(
      {
        getBootstrap: async (requestStartedAtMs) => {
          requestedAt.push(requestStartedAtMs);
          return olderResponse;
        },
      },
      () => olderTimes.shift() as number,
    );
    const newer = await requestPriceChangeBootstrap(
      {
        getBootstrap: async (requestStartedAtMs) => {
          requestedAt.push(requestStartedAtMs);
          return bootstrap;
        },
      },
      () => newerTimes.shift() as number,
    );
    finishOlder?.(bootstrap);
    const older = await olderPromise;

    expect(requestedAt).toEqual([
      Date.parse('2026-08-24T06:04:59.900Z'),
      Date.parse('2026-08-24T06:05:00.100Z'),
    ]);
    expect(older.requestStartedAt.getTime()).toBeLessThan(newer.requestStartedAt.getTime());
    expect(older.fetchedAt.getTime()).toBeGreaterThan(newer.fetchedAt.getTime());
  });

  it('keeps official preseason zero values as a usable board row', () => {
    const board = normalizePriceChangeBoard(
      bootstrapFixture({
        price_change_percent: 0,
        price_change_hourly_rate: 0,
        price_change_projections: [{ offset: 0, projected_percent: 0, likelihood: 0 }],
      }),
      new Date('2026-08-22T00:00:00Z'),
    );

    expect(board.status).toBe('READY');
    expect(board.observedPlayerCount).toBe(1);
    expect(board.players[0]).toMatchObject({
      progressPercent: 0,
      hourlyRate: 0,
      status: 'UNLIKELY',
      ownershipTrend: 'UP',
      teamShortName: 'TST',
    });
  });

  it('maps lock and calibrating overrides before likelihood', () => {
    const locked = normalizePriceChangeBoard(
      bootstrapFixture({ price_change_locked_until: '2026-08-23T12:00:00Z' }),
      new Date('2026-08-23T00:00:00Z'),
    );
    const calibrating = normalizePriceChangeBoard(
      bootstrapFixture({ price_change_calibrating: true }),
    );

    expect(locked.players[0]?.status).toBe('LOCKED');
    expect(calibrating.players[0]?.status).toBe('CALIBRATING');
  });

  it('treats an expired lock as unlocked and fails closed on missing fields', () => {
    const expired = normalizePriceChangeBoard(
      bootstrapFixture({ price_change_locked_until: '2026-08-22T12:00:00Z' }),
      new Date('2026-08-23T00:00:00Z'),
    );
    expect(expired.players[0]?.status).toBe('VERY_LIKELY_RISE');

    expect(() =>
      normalizePriceChangeBoard(
        bootstrapFixture({ price_change_percent: undefined }),
        new Date('2026-08-22T00:00:00Z'),
      ),
    ).toThrow(PriceChangePredictionValidationError);
  });

  it('keeps the publication freshness window separate from the legacy constant', () => {
    const board = normalizePriceChangeBoard(bootstrapFixture(), new Date('2026-08-22T00:00:00Z'));
    expect(board.staleAt).toBe(
      new Date(Date.parse('2026-08-22T00:00:00Z') + 10 * 60 * 1_000).toISOString(),
    );
    expect(PRICE_CHANGE_STALE_MS).toBe(60 * 60 * 1_000);
  });

  it('hard-expires the canonical publication at exactly one hour', () => {
    const fetchedAt = new Date('2026-08-22T00:00:00.000Z');
    const board = normalizePriceChangeBoard(bootstrapFixture(), fetchedAt);
    const publication = {
      manifest: {
        dataset: 'fpl:price-changes',
        eventId: null,
        state: 'active',
        publicationId: 'price-publication-test',
        revision: 1,
        items: [{ name: 'context' }, { name: 'players' }],
      },
      items: {
        context: {
          schemaVersion: 1,
          source: 'FPL_BOOTSTRAP',
          fetchedAt: fetchedAt.toISOString(),
          staleAt: new Date(fetchedAt.getTime() + PRICE_CHANGE_READY_MS).toISOString(),
          hardExpiresAt: new Date(fetchedAt.getTime() + PRICE_CHANGE_MAX_AGE_MS).toISOString(),
          deadline: board.deadline,
          nextDeadlines: board.nextDeadlines,
          expectedPlayerCount: board.expectedPlayerCount,
          observedPlayerCount: board.observedPlayerCount,
        },
        players: board.players,
      },
    } as never;

    expect(
      parsePublishedPriceChangeBoard(
        publication,
        new Date(fetchedAt.getTime() + PRICE_CHANGE_MAX_AGE_MS - 1),
      )?.status,
    ).toBe('STALE');
    expect(
      parsePublishedPriceChangeBoard(
        publication,
        new Date(fetchedAt.getTime() + PRICE_CHANGE_MAX_AGE_MS),
      ),
    ).toMatchObject({ status: 'UNAVAILABLE', revision: 'unavailable' });
  });
});
