import { z } from 'zod';
import { PlayerPosition } from './types';

/**
 * Player Schema
 */
export const PlayerSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  second_name: z.string(),
  web_name: z.string(),
  element_type: z.nativeEnum(PlayerPosition),
  team: z.number(),
  team_code: z.number(),
  status: z.string(),
  code: z.number(),
  now_cost: z.number(),
  news: z.string(),
  news_added: z.string().nullable(),
  chance_of_playing_next_round: z.number().nullable(),
  chance_of_playing_this_round: z.number().nullable(),
  form: z.string(),
  points_per_game: z.string(),
  selected_by_percent: z.string(),
  total_points: z.number(),
  minutes: z.number(),
  goals_scored: z.number(),
  assists: z.number(),
  clean_sheets: z.number(),
  goals_conceded: z.number(),
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
});

/**
 * Team Schema
 */
export const TeamSchema = z.object({
  id: z.number(),
  name: z.string(),
  short_name: z.string(),
  strength: z.number(),
  strength_overall_home: z.number(),
  strength_overall_away: z.number(),
  strength_attack_home: z.number(),
  strength_attack_away: z.number(),
  strength_defence_home: z.number(),
  strength_defence_away: z.number(),
  code: z.number(),
  form: z.string().nullable(),
  played: z.number(),
  win: z.number(),
  draw: z.number(),
  loss: z.number(),
  points: z.number(),
  position: z.number(),
  unavailable: z.boolean(),
});

/**
 * Event (Gameweek) Schema
 */
export const EventSchema = z.object({
  id: z.number(),
  name: z.string(),
  deadline_time: z.string(),
  average_entry_score: z.number(),
  finished: z.boolean(),
  data_checked: z.boolean(),
  highest_scoring_entry: z.number().nullable(),
  deadline_time_epoch: z.number(),
  deadline_time_game_offset: z.number(),
  highest_score: z.number().nullable(),
  is_previous: z.boolean(),
  is_current: z.boolean(),
  is_next: z.boolean(),
  most_selected: z.number().nullable(),
  most_transferred_in: z.number().nullable(),
  top_element: z.number().nullable(),
  transfers_made: z.number(),
  most_captained: z.number().nullable(),
  most_vice_captained: z.number().nullable(),
});

/**
 * Bootstrap Static Response Schema
 */
export const BootstrapStaticSchema = z.object({
  events: z.array(EventSchema),
  game_settings: z.record(z.unknown()),
  phases: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      start_event: z.number(),
      stop_event: z.number(),
    }),
  ),
  teams: z.array(TeamSchema),
  total_players: z.number(),
  elements: z.array(PlayerSchema),
  element_stats: z.array(
    z.object({
      label: z.string(),
      name: z.string(),
    }),
  ),
  element_types: z.array(
    z.object({
      id: z.number(),
      plural_name: z.string(),
      plural_name_short: z.string(),
      singular_name: z.string(),
      singular_name_short: z.string(),
      squad_select: z.number(),
      squad_min_play: z.number(),
      squad_max_play: z.number(),
      element_count: z.number(),
    }),
  ),
});

/**
 * Live Event Player Stats Schema
 */
export const LiveEventPlayerStatsSchema = z.object({
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
  total_points: z.number(),
  in_dreamteam: z.boolean(),
});

/**
 * Live Event Player Schema
 */
export const LiveEventPlayerSchema = z.object({
  id: z.number(),
  stats: LiveEventPlayerStatsSchema,
  explain: z.array(
    z.object({
      fixture: z.number(),
      stats: z.array(
        z.object({
          identifier: z.string(),
          points: z.number(),
          value: z.number(),
        }),
      ),
    }),
  ),
});

/**
 * Live Event Response Schema
 */
export const LiveEventResponseSchema = z.object({
  elements: z.array(LiveEventPlayerSchema),
});

/**
 * Fixture Schema
 */
export const FixtureSchema = z.object({
  code: z.number(),
  event: z.number(),
  finished: z.boolean(),
  finished_provisional: z.boolean(),
  id: z.number(),
  kickoff_time: z.string(),
  minutes: z.number(),
  provisional_start_time: z.boolean(),
  started: z.boolean(),
  team_a: z.number(),
  team_a_score: z.number().nullable(),
  team_h: z.number(),
  team_h_score: z.number().nullable(),
  stats: z.array(
    z.object({
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
    }),
  ),
  team_h_difficulty: z.number(),
  team_a_difficulty: z.number(),
});
