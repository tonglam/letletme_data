import { z } from 'zod';

import { FPLBootstrapResponse, RawFPLFixture } from '../types';
import { FPLClientError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

// Zod schemas for validation
const EventSchema = z.object({
  id: z.number(),
  name: z.string(),
  deadline_time: z.string().nullable(),
  release_time: z.string().nullable(),
  average_entry_score: z.number().nullable(),
  finished: z.boolean(),
  data_checked: z.boolean(),
  highest_scoring_entry: z.number().nullable(),
  deadline_time_epoch: z.number().nullable(),
  deadline_time_game_offset: z.number().nullable(),
  highest_score: z.number().nullable(),
  is_previous: z.boolean(),
  is_current: z.boolean(),
  is_next: z.boolean(),
  cup_leagues_created: z.boolean(),
  h2h_ko_matches_created: z.boolean(),
  can_enter: z.boolean(),
  can_manage: z.boolean(),
  released: z.boolean(),
  ranked_count: z.number(),
  overrides: z.object({
    rules: z.unknown(),
    scoring: z.unknown(),
    element_types: z.array(z.unknown()),
    pick_multiplier: z.unknown(),
  }),
  chip_plays: z.array(z.unknown()),
  most_selected: z.number().nullable(),
  most_transferred_in: z.number().nullable(),
  top_element: z.number().nullable(),
  top_element_info: z.unknown().nullable(),
  transfers_made: z.number().nullable(),
  most_captained: z.number().nullable(),
  most_vice_captained: z.number().nullable(),
});

const TeamSchema = z.object({
  code: z.number(),
  draw: z.number(),
  form: z.string().nullable(),
  id: z.number(),
  loss: z.number(),
  name: z.string(),
  played: z.number(),
  points: z.number(),
  position: z.number(),
  short_name: z.string(),
  strength: z.number(),
  team_division: z.number().nullable(),
  unavailable: z.boolean(),
  win: z.number(),
  strength_overall_home: z.number(),
  strength_overall_away: z.number(),
  strength_attack_home: z.number(),
  strength_attack_away: z.number(),
  strength_defence_home: z.number(),
  strength_defence_away: z.number(),
  pulse_id: z.number(),
});

const ElementSchema = z.object({
  id: z.number(),
  code: z.number(),
  element_type: z.number(),
  team: z.number(),
  now_cost: z.number(),
  cost_change_start: z.number(),
  cost_change_event: z.number(),
  cost_change_event_fall: z.number(),
  cost_change_start_fall: z.number(),
  first_name: z.string(),
  second_name: z.string(),
  web_name: z.string(),
  photo: z.string(),
  status: z.string(),
  selected_by_percent: z.string(),
  total_points: z.number(),
  points_per_game: z.string(),
  form: z.string(),
  dreamteam_count: z.number(),
  in_dreamteam: z.boolean(),
  special: z.boolean(),
  squad_number: z.number().nullable(),
  news: z.string(),
  news_added: z.string().nullable(),
  chance_of_playing_this_round: z.number().nullable(),
  chance_of_playing_next_round: z.number().nullable(),
  value_form: z.string(),
  value_season: z.string(),
  transfers_in: z.number(),
  transfers_out: z.number(),
  transfers_in_event: z.number(),
  transfers_out_event: z.number(),
  minutes: z.number(),
  goals_scored: z.number(),
  assists: z.number(),
  clean_sheets: z.number(),
  goals_conceded: z.number(),
  own_goals: z.number(),
  penalties_saved: z.number(),
  penalties_missed: z.number(),
  yellow_cards: z.number(),
  red_cards: z.number(),
  saves: z.number(),
  bonus: z.number(),
  bps: z.number(),
  influence: z.string(),
  creativity: z.string(),
  threat: z.string(),
  ict_index: z.string(),
  expected_goals: z.string(),
  expected_assists: z.string(),
  expected_goal_involvements: z.string(),
  expected_goals_conceded: z.string(),
});

const PhaseSchema = z.object({
  id: z.number(),
  name: z.string(),
  start_event: z.number(),
  stop_event: z.number(),
  highest_score: z.number().nullable(),
});

const FixtureStatSchema = z.object({
  identifier: z.string(),
  a: z.array(
    z.object({
      value: z.number(),
      element: z.number(),
    }),
  ),
  h: z.array(
    z.object({
      value: z.number(),
      element: z.number(),
    }),
  ),
});

const FixtureSchema = z.object({
  code: z.number(),
  event: z.number().nullable(),
  finished: z.boolean(),
  finished_provisional: z.boolean(),
  id: z.number(),
  kickoff_time: z.string().nullable(),
  minutes: z.number(),
  provisional_start_time: z.boolean(),
  started: z.boolean().nullable(),
  team_a: z.number(),
  team_a_score: z.number().nullable(),
  team_h: z.number(),
  team_h_score: z.number().nullable(),
  stats: z.array(FixtureStatSchema),
  team_h_difficulty: z.number().nullable(),
  team_a_difficulty: z.number().nullable(),
  pulse_id: z.number(),
});

const BootstrapResponseSchema = z.object({
  events: z.array(EventSchema),
  teams: z.array(TeamSchema),
  elements: z.array(ElementSchema),
  game_settings: z.unknown(),
  phases: z.array(PhaseSchema),
  total_players: z.number(),
  element_stats: z.array(z.unknown()),
  element_types: z.array(z.unknown()),
});

class FPLClient {
  private readonly baseUrl = 'https://fantasy.premierleague.com/api';

  async getBootstrap(): Promise<FPLBootstrapResponse> {
    const url = `${this.baseUrl}/bootstrap-static/`;

    try {
      logInfo('Fetching FPL bootstrap data', { url });

      const response = await fetch(url);

      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      // Validate with Zod
      const validated = BootstrapResponseSchema.parse(data);

      logInfo('Successfully fetched and validated FPL bootstrap data', {
        eventCount: validated.events.length,
        teamCount: validated.teams.length,
        playerCount: validated.elements.length,
        phaseCount: validated.phases.length,
      });

      return validated as FPLBootstrapResponse;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('FPL bootstrap data validation failed', error);
        throw new FPLClientError(
          'Invalid response format from FPL API',
          undefined,
          'VALIDATION_ERROR',
          error,
        );
      }

      if (error instanceof FPLClientError) {
        logError('FPL client error', error);
        throw error;
      }

      logError('Unexpected error fetching FPL bootstrap data', error);
      throw new FPLClientError(
        'Failed to fetch bootstrap data',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async getFixtures(eventId?: number): Promise<RawFPLFixture[]> {
    const url = eventId
      ? `${this.baseUrl}/fixtures/?event=${eventId}`
      : `${this.baseUrl}/fixtures/`;

    try {
      logInfo('Fetching fixtures', { eventId, url });

      const response = await fetch(url);

      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      // Validate with Zod
      const validated = z.array(FixtureSchema).parse(data);

      logInfo('Successfully fetched and validated fixtures', {
        eventId,
        fixtureCount: validated.length,
      });

      return validated as RawFPLFixture[];
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('Fixtures data validation failed', error);
        throw new FPLClientError(
          'Invalid response format from FPL API',
          undefined,
          'VALIDATION_ERROR',
          error,
        );
      }

      if (error instanceof FPLClientError) {
        logError('FPL client error', error);
        throw error;
      }

      logError('Unexpected error fetching fixtures', error);
      throw new FPLClientError(
        'Failed to fetch fixtures',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async getEventLive(eventId: number): Promise<unknown> {
    const url = `${this.baseUrl}/event/${eventId}/live/`;

    try {
      logInfo('Fetching event live data', { eventId, url });

      const response = await fetch(url);

      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      logInfo('Successfully fetched event live data', { eventId });

      return data;
    } catch (error) {
      if (error instanceof FPLClientError) {
        logError('FPL client error', error);
        throw error;
      }

      logError('Unexpected error fetching event live data', error);
      throw new FPLClientError(
        'Failed to fetch event live data',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

// Export singleton instance
export const fplClient = new FPLClient();
