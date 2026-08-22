import { describe, expect, it } from 'bun:test';

import type { FPLBootstrapResponse } from '../../src/clients/fpl';
import {
  normalizePriceChangeBoard,
  PRICE_CHANGE_STALE_MS,
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
    );
    const calibrating = normalizePriceChangeBoard(
      bootstrapFixture({ price_change_calibrating: true }),
    );

    expect(locked.players[0]?.status).toBe('LOCKED');
    expect(calibrating.players[0]?.status).toBe('CALIBRATING');
  });

  it('reports partial coverage when optional official fields are absent', () => {
    const board = normalizePriceChangeBoard(
      bootstrapFixture({ price_change_percent: undefined }),
      new Date('2026-08-22T00:00:00Z'),
    );

    expect(board.status).toBe('PARTIAL');
    expect(board.expectedPlayerCount).toBe(1);
    expect(board.observedPlayerCount).toBe(0);
    expect(board.staleAt).toBe(
      new Date(Date.parse('2026-08-22T00:00:00Z') + PRICE_CHANGE_STALE_MS).toISOString(),
    );
  });
});
