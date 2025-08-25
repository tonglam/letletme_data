// Core domain types
export type EventID = number;
export type PlayerID = number;
export type TeamID = number;
export type EntryID = number;
export type PhaseID = number;

// Event types
export interface Event {
  id: EventID;
  name: string;
  deadlineTime: Date | null;
  averageEntryScore: number | null;
  finished: boolean;
  dataChecked: boolean;
  highestScoringEntry: number | null;
  deadlineTimeEpoch: number | null;
  deadlineTimeGameOffset: number | null;
  highestScore: number | null;
  isPrevious: boolean;
  isCurrent: boolean;
  isNext: boolean;
  cupLeagueCreate: boolean;
  h2hKoMatchesCreated: boolean;
  chipPlays: unknown[] | null;
  mostSelected: number | null;
  mostTransferredIn: number | null;
  topElement: number | null;
  topElementInfo: unknown | null;
  transfersMade: number | null;
  mostCaptained: number | null;
  mostViceCaptained: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// Player types
export interface Player {
  id: PlayerID;
  code: number;
  type: number;
  teamId: TeamID;
  price: number;
  startPrice: number;
  firstName: string;
  secondName: string;
  webName: string;
}

// Team types - using database schema types
export type Team = import('../db/schema').Team;

// Phase types
export interface Phase {
  id: PhaseID;
  name: string;
  startEvent: number;
  stopEvent: number;
  highestScore: number | null;
}

// Raw FPL API Response types
export interface RawFPLEvent {
  id: number;
  name: string;
  deadline_time: string | null;
  release_time: string | null;
  average_entry_score: number | null;
  finished: boolean;
  data_checked: boolean;
  highest_scoring_entry: number | null;
  deadline_time_epoch: number | null;
  deadline_time_game_offset: number | null;
  highest_score: number | null;
  is_previous: boolean;
  is_current: boolean;
  is_next: boolean;
  cup_leagues_created: boolean;
  h2h_ko_matches_created: boolean;
  can_enter: boolean;
  can_manage: boolean;
  released: boolean;
  ranked_count: number;
  overrides: {
    rules: unknown;
    scoring: unknown;
    element_types: unknown[];
    pick_multiplier: unknown;
  };
  chip_plays: unknown[];
  most_selected: number | null;
  most_transferred_in: number | null;
  top_element: number | null;
  top_element_info: unknown | null;
  transfers_made: number | null;
  most_captained: number | null;
  most_vice_captained: number | null;
}

export interface RawFPLTeam {
  code: number;
  draw: number;
  form: string | null;
  id: number;
  loss: number;
  name: string;
  played: number;
  points: number;
  position: number;
  short_name: string;
  strength: number;
  team_division: number | null;
  unavailable: boolean;
  win: number;
  strength_overall_home: number;
  strength_overall_away: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_defence_home: number;
  strength_defence_away: number;
  pulse_id: number;
}

export interface RawFPLPhase {
  id: number;
  name: string;
  start_event: number;
  stop_event: number;
  highest_score: number | null;
}

export interface RawFPLElement {
  id: number;
  code: number;
  element_type: number;
  team: number;
  now_cost: number;
  cost_change_start: number;
  cost_change_event: number;
  cost_change_event_fall: number;
  cost_change_start_fall: number;
  first_name: string;
  second_name: string;
  web_name: string;
  photo: string;
  status: string;
  selected_by_percent: string;
  total_points: number;
  points_per_game: string;
  form: string;
  dreamteam_count: number;
  in_dreamteam: boolean;
  special: boolean;
  squad_number: number | null;
  news: string;
  news_added: string | null;
  chance_of_playing_this_round: number | null;
  chance_of_playing_next_round: number | null;
  value_form: string;
  value_season: string;
  transfers_in: number;
  transfers_out: number;
  transfers_in_event: number;
  transfers_out_event: number;
  // Performance stats (many more fields available)
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  bonus: number;
  bps: number;
  influence: string;
  creativity: string;
  threat: string;
  ict_index: string;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;
}

// API Response types
export interface FPLBootstrapResponse {
  events: RawFPLEvent[];
  game_settings: unknown;
  phases: RawFPLPhase[];
  teams: RawFPLTeam[];
  total_players: number;
  elements: RawFPLElement[];
  element_stats: unknown[];
  element_types: unknown[];
}

// Error types
export interface APIError extends Error {
  status?: number;
  code?: string;
}

// Cache types
export interface CacheConfig {
  ttl: number;
  prefix: string;
}
