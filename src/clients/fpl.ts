import { z } from 'zod';

import {
  FPLBootstrapResponse,
  RawFPLEventLiveResponse,
  RawFPLFixture,
  RawFPLEntryHistoryResponse,
  RawFPLLeagueStandingsResponse,
  RawFPLEntryCupResponse,
  RawFPLEntryTransfersResponse,
} from '../types';
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

  async getEventLive(eventId: number): Promise<RawFPLEventLiveResponse> {
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

      // Validate with Zod
      const EventLiveStatsSchema = z.object({
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
        starts: z.number(),
        expected_goals: z.string(),
        expected_assists: z.string(),
        expected_goal_involvements: z.string(),
        expected_goals_conceded: z.string(),
        total_points: z.number(),
        in_dreamteam: z.boolean(),
      });

      const EventLiveElementSchema = z.object({
        id: z.number(),
        stats: EventLiveStatsSchema,
        explain: z.array(z.unknown()),
      });

      const EventLiveResponseSchema = z.object({
        elements: z.array(EventLiveElementSchema),
      });

      const validated = EventLiveResponseSchema.parse(data);

      logInfo('Successfully fetched and validated event live data', {
        eventId,
        elementCount: validated.elements.length,
      });

      return validated as RawFPLEventLiveResponse;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('Event live data validation failed', error);
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

      logError('Unexpected error fetching event live data', error);
      throw new FPLClientError(
        'Failed to fetch event live data',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async getEntrySummary(entryId: number) {
    const url = `${this.baseUrl}/entry/${entryId}/`;
    try {
      logInfo('Fetching entry summary', { entryId, url });

      const response = await fetch(url);
      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      // Validate a minimal subset we depend on
      const LeagueItemSchema = z.object({
        id: z.number(),
        name: z.string(),
        short_name: z.string().nullable().optional(),
        created: z.string().optional(),
        entry_rank: z.number().nullable(),
        entry_last_rank: z.number().nullable(),
        start_event: z.number().nullable().optional(),
      });

      const EntryLeaguesSchema = z
        .object({
          classic: z.array(LeagueItemSchema),
          h2h: z.array(LeagueItemSchema),
        })
        .passthrough()
        .optional();

      const EntrySummarySchema = z.object({
        id: z.number(),
        name: z.string(),
        player_first_name: z.string(),
        player_last_name: z.string(),
        player_region_name: z.string().nullable().optional(),
        started_event: z.number().nullable().optional(),
        summary_overall_points: z.number().nullable().optional(),
        summary_overall_rank: z.number().nullable().optional(),
        bank: z.number().nullable().optional(),
        value: z.number().nullable().optional(),
        last_deadline_total_transfers: z.number().nullable().optional(),
        last_deadline_bank: z.number().nullable().optional(),
        last_deadline_total_points: z.number().nullable().optional(),
        last_deadline_rank: z.number().nullable().optional(),
        last_deadline_value: z.number().nullable().optional(),
        leagues: EntryLeaguesSchema,
      });

      const validated = EntrySummarySchema.parse(data);
      logInfo('Successfully fetched and validated entry summary', { entryId });
      return validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('Entry summary validation failed', error);
        throw new FPLClientError(
          'Invalid entry summary format from FPL API',
          undefined,
          'VALIDATION_ERROR',
          error,
        );
      }
      if (error instanceof FPLClientError) {
        logError('FPL client error', error);
        throw error;
      }
      logError('Unexpected error fetching entry summary', error);
      throw new FPLClientError(
        'Failed to fetch entry summary',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async getEntryEventPicks(entryId: number, eventId: number) {
    const url = `${this.baseUrl}/entry/${entryId}/event/${eventId}/picks/`;
    try {
      logInfo('Fetching entry event picks', { entryId, eventId, url });

      const response = await fetch(url);
      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      const PickItemSchema = z.object({
        element: z.number(),
        position: z.number(),
        multiplier: z.number(),
        is_captain: z.boolean(),
        is_vice_captain: z.boolean(),
      });

      const EntryHistorySchema = z.object({
        event: z.number(),
        points: z.number(),
        total_points: z.number(),
        rank: z.number().nullable(),
        overall_rank: z.number().nullable(),
        bank: z.number(),
        value: z.number(),
        event_transfers: z.number(),
        event_transfers_cost: z.number(),
        points_on_bench: z.number(),
      });

      const PicksResponseSchema = z.object({
        active_chip: z.enum(['wildcard', 'freehit', 'bboost', '3xc']).nullable(),
        automatic_subs: z.array(z.unknown()),
        entry_history: EntryHistorySchema,
        picks: z.array(PickItemSchema),
      });

      const validated = PicksResponseSchema.parse(data);
      logInfo('Successfully fetched and validated entry event picks', {
        entryId,
        eventId,
        pickCount: validated.picks.length,
        activeChip: validated.active_chip ?? 'n/a',
      });
      return validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('Entry event picks validation failed', error);
        throw new FPLClientError(
          'Invalid entry event picks format from FPL API',
          undefined,
          'VALIDATION_ERROR',
          error,
        );
      }
      if (error instanceof FPLClientError) {
        logError('FPL client error', error);
        throw error;
      }
      logError('Unexpected error fetching entry event picks', error);
      throw new FPLClientError(
        'Failed to fetch entry event picks',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async getLeagueStandings(
    url: string,
    leagueId: number,
    page: number,
    leagueType: 'classic' | 'h2h',
  ): Promise<RawFPLLeagueStandingsResponse> {
    try {
      logInfo('Fetching league standings', { leagueId, page, leagueType, url });

      const response = await fetch(url);
      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      const StandingsResultSchema = z.object({ entry: z.number() }).passthrough();
      const StandingsSchema = z
        .object({
          has_next: z.boolean(),
          results: z.array(StandingsResultSchema),
        })
        .passthrough();
      const LeagueSchema = z
        .object({
          id: z.number(),
          name: z.string(),
        })
        .passthrough();
      const LeagueStandingsSchema = z
        .object({ standings: StandingsSchema, league: LeagueSchema.optional() })
        .passthrough();

      const validated = LeagueStandingsSchema.parse(data);
      logInfo('Successfully fetched league standings', {
        leagueId,
        page,
        leagueType,
        entryCount: validated.standings.results.length,
      });
      return validated as RawFPLLeagueStandingsResponse;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('League standings validation failed', error, { leagueId, leagueType, page });
        throw new FPLClientError(
          'Invalid league standings format from FPL API',
          undefined,
          'VALIDATION_ERROR',
          error,
        );
      }

      if (error instanceof FPLClientError) {
        logError('FPL client error', error, { leagueId, leagueType, page });
        throw error;
      }

      logError('Unexpected error fetching league standings', error, { leagueId, leagueType, page });
      throw new FPLClientError(
        'Failed to fetch league standings',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async getLeagueClassicStandings(
    leagueId: number,
    page: number,
  ): Promise<RawFPLLeagueStandingsResponse> {
    const url = `${this.baseUrl}/leagues-classic/${leagueId}/standings/?page_standings=${page}`;
    return this.getLeagueStandings(url, leagueId, page, 'classic');
  }

  async getLeagueH2HStandings(
    leagueId: number,
    page: number,
  ): Promise<RawFPLLeagueStandingsResponse> {
    const url = `${this.baseUrl}/leagues-h2h/${leagueId}/standings/?page_standings=${page}`;
    return this.getLeagueStandings(url, leagueId, page, 'h2h');
  }

  async getEntryTransfers(entryId: number): Promise<RawFPLEntryTransfersResponse> {
    const url = `${this.baseUrl}/entry/${entryId}/transfers/`;
    try {
      logInfo('Fetching entry transfers', { entryId, url });

      const response = await fetch(url);
      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      const TransferSchema = z.object({
        element_in: z.number(),
        element_in_cost: z.number(),
        element_in_points: z.number().nullable().optional(),
        element_out: z.number(),
        element_out_cost: z.number(),
        element_out_points: z.number().nullable().optional(),
        entry: z.number(),
        event: z.number(),
        time: z.string(),
      });

      const TransfersSchema = z.array(TransferSchema);
      const validated = TransfersSchema.parse(data);

      logInfo('Successfully fetched and validated entry transfers', {
        entryId,
        count: validated.length,
      });
      return validated as RawFPLEntryTransfersResponse;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('Entry transfers validation failed', error);
        throw new FPLClientError(
          'Invalid entry transfers format from FPL API',
          undefined,
          'VALIDATION_ERROR',
          error,
        );
      }
      if (error instanceof FPLClientError) {
        logError('FPL client error', error);
        throw error;
      }
      logError('Unexpected error fetching entry transfers', error);
      throw new FPLClientError(
        'Failed to fetch entry transfers',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async getEntryHistory(entryId: number): Promise<RawFPLEntryHistoryResponse> {
    const url = `${this.baseUrl}/entry/${entryId}/history/`;
    try {
      logInfo('Fetching entry history', { entryId, url });

      const response = await fetch(url);
      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      const EntryHistoryPastSeasonSchema = z.object({
        season_name: z.string(),
        total_points: z.number(),
        rank: z.number(),
      });

      const EntryHistoryCurrentItemSchema = z.object({
        event: z.number(),
        points: z.number(),
        total_points: z.number(),
        rank: z.number().nullable().optional(),
        overall_rank: z.number().nullable().optional(),
      });

      const EntryHistoryResponseSchema = z.object({
        current: z.array(EntryHistoryCurrentItemSchema),
        chips: z.array(z.unknown()),
        past: z.array(EntryHistoryPastSeasonSchema),
      });

      const validated = EntryHistoryResponseSchema.parse(data);
      logInfo('Successfully fetched and validated entry history', {
        entryId,
        pastSeasons: validated.past.length,
        currentSnapshots: validated.current.length,
      });
      return validated as RawFPLEntryHistoryResponse;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('Entry history validation failed', error);
        throw new FPLClientError(
          'Invalid entry history format from FPL API',
          undefined,
          'VALIDATION_ERROR',
          error,
        );
      }
      if (error instanceof FPLClientError) {
        logError('FPL client error', error);
        throw error;
      }
      logError('Unexpected error fetching entry history', error);
      throw new FPLClientError(
        'Failed to fetch entry history',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async getEntryCup(entryId: number): Promise<RawFPLEntryCupResponse> {
    const url = `${this.baseUrl}/entry/${entryId}/cup/`;
    try {
      logInfo('Fetching entry cup', { entryId, url });

      const response = await fetch(url);
      if (!response.ok) {
        throw new FPLClientError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          'HTTP_ERROR',
        );
      }

      const data: unknown = await response.json();

      const CupMatchSchema = z.object({
        event: z.number(),
        entry_1_entry: z.number(),
        entry_1_name: z.string(),
        entry_1_player_name: z.string(),
        entry_1_points: z.number().nullable(),
        entry_2_entry: z.number(),
        entry_2_name: z.string(),
        entry_2_player_name: z.string(),
        entry_2_points: z.number().nullable(),
        winner: z.number().nullable(),
      });

      const CupResponseSchema = z
        .object({
          cup_matches: z.array(CupMatchSchema),
          cup_status: z.unknown().optional(),
        })
        .passthrough();

      const validated = CupResponseSchema.parse(data);
      logInfo('Successfully fetched and validated entry cup', {
        entryId,
        matchCount: validated.cup_matches.length,
      });
      return validated as RawFPLEntryCupResponse;
    } catch (error) {
      if (error instanceof z.ZodError) {
        logError('Entry cup validation failed', error);
        throw new FPLClientError(
          'Invalid entry cup format from FPL API',
          undefined,
          'VALIDATION_ERROR',
          error,
        );
      }
      if (error instanceof FPLClientError) {
        logError('FPL client error', error);
        throw error;
      }
      logError('Unexpected error fetching entry cup', error);
      throw new FPLClientError(
        'Failed to fetch entry cup',
        undefined,
        'UNKNOWN_ERROR',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

// Export singleton instance
export const fplClient = new FPLClient();
