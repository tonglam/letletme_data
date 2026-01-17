// Core domain types
export type EventID = number;
export type PlayerID = number;
export type TeamID = number;
export type EntryID = number;
export type PhaseID = number;
export type FixtureID = number;

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

// Fixture types
export interface FixtureStat {
  identifier: string;
  a: Array<{ value: number; element: number }>;
  h: Array<{ value: number; element: number }>;
}

export interface Fixture {
  id: FixtureID;
  code: number;
  event: EventID | null;
  finished: boolean;
  finishedProvisional: boolean;
  kickoffTime: Date | null;
  minutes: number;
  provisionalStartTime: boolean;
  started: boolean | null;
  teamA: TeamID;
  teamAScore: number | null;
  teamH: TeamID;
  teamHScore: number | null;
  stats: FixtureStat[];
  teamHDifficulty: number | null;
  teamADifficulty: number | null;
  pulseId: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

// Event standings
export interface EventStanding {
  eventId: EventID;
  position: number;
  teamId: TeamID;
  teamName: string;
  teamShortName: string;
  points: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalsDifference: number;
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

export interface RawFPLFixtureStat {
  identifier: string;
  a: Array<{ value: number; element: number }>;
  h: Array<{ value: number; element: number }>;
}

export interface RawFPLFixture {
  code: number;
  event: number | null;
  finished: boolean;
  finished_provisional: boolean;
  id: number;
  kickoff_time: string | null;
  minutes: number;
  provisional_start_time: boolean;
  started: boolean | null;
  team_a: number;
  team_a_score: number | null;
  team_h: number;
  team_h_score: number | null;
  stats: RawFPLFixtureStat[];
  team_h_difficulty: number | null;
  team_a_difficulty: number | null;
  pulse_id: number;
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
  // These fields are NOT available in bootstrap-static endpoint
  // They may be available in other endpoints like /element-summary/
  starts?: number;
  influence_rank?: number;
  influence_rank_type?: number;
  creativity_rank?: number;
  creativity_rank_type?: number;
  threat_rank?: number;
  threat_rank_type?: number;
  ict_index_rank?: number;
  ict_index_rank_type?: number;
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

// Raw FPL Event Live Response
export interface RawFPLEventLiveStats {
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
  starts: number;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;
  total_points: number;
  in_dreamteam: boolean;
}

export interface RawFPLEventLiveElement {
  id: number;
  stats: RawFPLEventLiveStats;
  explain: unknown[];
}

export interface RawFPLEventLiveResponse {
  elements: RawFPLEventLiveElement[];
}

// Entry summary (FPL: /api/entry/{entryId}/)
export interface RawFPLEntrySummary {
  id: number;
  name: string;
  player_first_name: string;
  player_last_name: string;
  player_region_name?: string | null;
  started_event?: number | null;
  summary_overall_points?: number | null;
  summary_overall_rank?: number | null;
  bank?: number | null; // in tenths
  value?: number | null; // in tenths
  last_deadline_total_transfers?: number | null;
  last_deadline_bank?: number | null;
  last_deadline_total_points?: number | null;
  last_deadline_rank?: number | null;
  last_deadline_value?: number | null; // in tenths
  leagues?: RawFPLEntryLeagues; // optional leagues block
}

// Entry history (FPL: /api/entry/{entryId}/history/)
export interface RawFPLEntryHistoryPastSeason {
  season_name: string; // e.g., "2024/25"
  total_points: number; // season total
  rank: number; // final overall rank
}

export interface RawFPLEntryHistoryCurrentItem {
  event: number; // GW
  points: number;
  total_points: number;
  rank?: number | null; // GW rank (not used)
  overall_rank?: number | null; // snapshot overall rank
}

export interface RawFPLEntryHistoryResponse {
  current: RawFPLEntryHistoryCurrentItem[];
  chips: unknown[];
  past: RawFPLEntryHistoryPastSeason[];
}

// Leagues subsection of Entry Summary
export interface RawFPLLeagueItem {
  id: number;
  name: string;
  short_name?: string | null;
  created?: string;
  entry_rank: number | null;
  entry_last_rank: number | null;
  start_event?: number | null;
}

export interface RawFPLEntryLeagues {
  classic: RawFPLLeagueItem[];
  h2h: RawFPLLeagueItem[];
  // other keys exist (cup, cup_matches); ignored
}

export interface RawFPLLeagueStandingsResult {
  entry: number;
}

export interface RawFPLLeagueStandings {
  results: RawFPLLeagueStandingsResult[];
  has_next: boolean;
}

export interface RawFPLLeagueInfo {
  id: number;
  name: string;
}

export interface RawFPLLeagueStandingsResponse {
  league?: RawFPLLeagueInfo;
  standings: RawFPLLeagueStandings;
}

// Pulselive standings (Premier League tables)
export interface RawPulseLiveStandingsClub {
  abbr: string;
}

export interface RawPulseLiveStandingsTeam {
  club: RawPulseLiveStandingsClub;
}

export interface RawPulseLiveStandingsOverall {
  points: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalsDifference: number;
}

export interface RawPulseLiveStandingsEntry {
  position: number;
  team: RawPulseLiveStandingsTeam;
  overall: RawPulseLiveStandingsOverall;
}

export interface RawPulseLiveStandingsTable {
  entries: RawPulseLiveStandingsEntry[];
}

export interface RawPulseLiveStandingsResponse {
  tables: RawPulseLiveStandingsTable[];
}

// Entry event picks (FPL: /api/entry/{entryId}/event/{eventId}/picks/)
export interface RawFPLEntryEventPickItem {
  element: number;
  position: number;
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
}

export interface RawFPLEntryEventPicksEntryHistory {
  event: number;
  points: number;
  total_points: number;
  rank: number | null;
  overall_rank: number | null;
  bank: number;
  value: number;
  event_transfers: number;
  event_transfers_cost: number;
  points_on_bench: number;
}

export interface RawFPLEntryEventPicksResponse {
  active_chip: 'wildcard' | 'freehit' | 'bboost' | '3xc' | null;
  automatic_subs: unknown[];
  entry_history: RawFPLEntryEventPicksEntryHistory;
  picks: RawFPLEntryEventPickItem[];
}

// Entry transfers (FPL: /api/entry/{entryId}/transfers/)
export interface RawFPLEntryTransfer {
  element_in: number;
  element_in_cost: number; // tenths
  element_in_points?: number | null; // sometimes unavailable
  element_out: number;
  element_out_cost: number; // tenths
  element_out_points?: number | null; // sometimes unavailable
  entry: number;
  event: number; // GW
  time: string; // ISO
}

export type RawFPLEntryTransfersResponse = RawFPLEntryTransfer[];

// Entry cup (FPL: /api/entry/{entryId}/cup/)
export interface RawFPLEntryCupMatch {
  event: number;
  entry_1_entry: number;
  entry_1_name: string;
  entry_1_player_name: string;
  entry_1_points: number | null;
  entry_2_entry: number;
  entry_2_name: string;
  entry_2_player_name: string;
  entry_2_points: number | null;
  winner: number | null; // 0 when not decided
}

export interface RawFPLEntryCupResponse {
  cup_matches: RawFPLEntryCupMatch[];
  cup_status?: unknown;
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
