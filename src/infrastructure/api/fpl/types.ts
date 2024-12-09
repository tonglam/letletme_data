import { APIResponse } from '../common/types';

/**
 * FPL Event (Gameweek) Status
 */
export enum EventStatus {
  ONGOING = 'ONGOING',
  FINISHED = 'FINISHED',
  PENDING = 'PENDING',
}

/**
 * FPL Player Position
 */
export enum PlayerPosition {
  GOALKEEPER = 1,
  DEFENDER = 2,
  MIDFIELDER = 3,
  FORWARD = 4,
}

/**
 * Bootstrap Static Response
 */
export interface BootstrapStaticResponse {
  readonly events: Event[];
  readonly game_settings: GameSettings;
  readonly phases: Phase[];
  readonly teams: Team[];
  readonly total_players: number;
  readonly elements: Player[];
  readonly element_stats: ElementStats[];
  readonly element_types: ElementType[];
}

/**
 * Event (Gameweek)
 */
export interface Event {
  readonly id: number;
  readonly name: string;
  readonly deadline_time: string;
  readonly average_entry_score: number;
  readonly finished: boolean;
  readonly data_checked: boolean;
  readonly highest_scoring_entry: number;
  readonly deadline_time_epoch: number;
  readonly deadline_time_game_offset: number;
  readonly highest_score: number;
  readonly is_previous: boolean;
  readonly is_current: boolean;
  readonly is_next: boolean;
  readonly chip_plays: ChipPlay[];
  readonly most_selected: number;
  readonly most_transferred_in: number;
  readonly top_element: number;
  readonly top_element_info: TopElementInfo;
  readonly transfers_made: number;
  readonly most_captained: number;
  readonly most_vice_captained: number;
}

/**
 * Game Settings
 */
export interface GameSettings {
  readonly league_join_private_max: number;
  readonly league_join_public_max: number;
  readonly league_max_size_public_classic: number;
  readonly league_max_size_public_h2h: number;
  readonly league_max_size_private_h2h: number;
  readonly league_max_ko_rounds_private_h2h: number;
  readonly squad_squadplay: number;
  readonly squad_squadsize: number;
  readonly squad_team_limit: number;
  readonly squad_total_spend: number;
  readonly ui_currency_multiplier: number;
  readonly ui_use_special_shirts: boolean;
  readonly stats_form_days: number;
  readonly sys_vice_captain_enabled: boolean;
  readonly transfers_cap: number;
  readonly transfers_sell_on_fee: number;
  readonly league_h2h_tiebreak_stats: string[];
}

/**
 * Team
 */
export interface Team {
  readonly code: number;
  readonly draw: number;
  readonly form: string | null;
  readonly id: number;
  readonly loss: number;
  readonly name: string;
  readonly played: number;
  readonly points: number;
  readonly position: number;
  readonly short_name: string;
  readonly strength: number;
  readonly strength_attack_away: number;
  readonly strength_attack_home: number;
  readonly strength_defence_away: number;
  readonly strength_defence_home: number;
  readonly strength_overall_away: number;
  readonly strength_overall_home: number;
  readonly team_division: number | null;
  readonly unavailable: boolean;
  readonly win: number;
}

/**
 * Player
 */
export interface Player {
  readonly chance_of_playing_next_round: number | null;
  readonly chance_of_playing_this_round: number | null;
  readonly code: number;
  readonly cost_change_event: number;
  readonly cost_change_start: number;
  readonly dreamteam_count: number;
  readonly element_type: PlayerPosition;
  readonly ep_next: string | null;
  readonly ep_this: string | null;
  readonly event_points: number;
  readonly first_name: string;
  readonly form: string;
  readonly id: number;
  readonly in_dreamteam: boolean;
  readonly news: string;
  readonly news_added: string | null;
  readonly now_cost: number;
  readonly photo: string;
  readonly points_per_game: string;
  readonly second_name: string;
  readonly selected_by_percent: string;
  readonly special: boolean;
  readonly squad_number: number | null;
  readonly status: string;
  readonly team: number;
  readonly team_code: number;
  readonly total_points: number;
  readonly transfers_in: number;
  readonly transfers_in_event: number;
  readonly transfers_out: number;
  readonly transfers_out_event: number;
  readonly value_form: string;
  readonly value_season: string;
  readonly web_name: string;
  readonly minutes: number;
  readonly goals_scored: number;
  readonly assists: number;
  readonly clean_sheets: number;
  readonly goals_conceded: number;
  readonly own_goals: number;
  readonly penalties_saved: number;
  readonly penalties_missed: number;
  readonly yellow_cards: number;
  readonly red_cards: number;
  readonly saves: number;
  readonly bonus: number;
  readonly bps: number;
  readonly influence: string;
  readonly creativity: string;
  readonly threat: string;
  readonly ict_index: string;
}

/**
 * Live Event Response
 */
export interface LiveEventResponse {
  readonly elements: LiveEventPlayer[];
}

/**
 * Live Event Player
 */
export interface LiveEventPlayer {
  readonly id: number;
  readonly stats: LiveEventPlayerStats;
  readonly explain: ExplainStats[];
}

/**
 * Player Stats in Live Event
 */
export interface LiveEventPlayerStats {
  readonly minutes: number;
  readonly goals_scored: number;
  readonly assists: number;
  readonly clean_sheets: number;
  readonly goals_conceded: number;
  readonly own_goals: number;
  readonly penalties_saved: number;
  readonly penalties_missed: number;
  readonly yellow_cards: number;
  readonly red_cards: number;
  readonly saves: number;
  readonly bonus: number;
  readonly bps: number;
  readonly influence: string;
  readonly creativity: string;
  readonly threat: string;
  readonly ict_index: string;
  readonly total_points: number;
  readonly in_dreamteam: boolean;
}

/**
 * Explain Stats Entry
 */
export interface ExplainStats {
  readonly fixture: number;
  readonly stats: StatExplanation[];
}

/**
 * Stat Explanation
 */
export interface StatExplanation {
  readonly identifier: string;
  readonly points: number;
  readonly value: number;
}

/**
 * Response Types
 */
export type BootstrapResponse = APIResponse<BootstrapStaticResponse>;
export type LiveEventDataResponse = APIResponse<LiveEventResponse>;
export type FixturesResponse = APIResponse<Fixture[]>;
export type EntryResponse = APIResponse<Entry>;
export type EntryHistoryResponse = APIResponse<EntryHistory>;
export type ElementSummaryResponse = APIResponse<ElementSummary>;
export type EntryEventPicksResponse = APIResponse<EntryEventPicks>;
export type EntryTransfersResponse = APIResponse<EntryTransfer[]>;
export type LeagueClassicResponse = APIResponse<LeagueClassic>;
export type LeagueH2HResponse = APIResponse<LeagueH2H>;

/**
 * Phase (Season Part)
 */
export interface Phase {
  readonly id: number;
  readonly name: string;
  readonly start_event: number;
  readonly stop_event: number;
}

/**
 * Element Stats
 */
export interface ElementStats {
  readonly label: string;
  readonly name: string;
}

/**
 * Element Type (Player Position Details)
 */
export interface ElementType {
  readonly id: number;
  readonly plural_name: string;
  readonly plural_name_short: string;
  readonly singular_name: string;
  readonly singular_name_short: string;
  readonly squad_select: number;
  readonly squad_min_play: number;
  readonly squad_max_play: number;
  readonly element_count: number;
}

/**
 * Chip Play
 */
export interface ChipPlay {
  readonly chip_name: string;
  readonly num_played: number;
}

/**
 * Top Element Info
 */
export interface TopElementInfo {
  readonly id: number;
  readonly points: number;
}

/**
 * Fixture
 */
export interface Fixture {
  readonly code: number;
  readonly event: number;
  readonly finished: boolean;
  readonly finished_provisional: boolean;
  readonly id: number;
  readonly kickoff_time: string;
  readonly minutes: number;
  readonly provisional_start_time: boolean;
  readonly started: boolean;
  readonly team_a: number;
  readonly team_a_score: number | null;
  readonly team_h: number;
  readonly team_h_score: number | null;
  readonly stats: FixtureStats[];
  readonly team_h_difficulty: number;
  readonly team_a_difficulty: number;
}

/**
 * Fixture Stats
 */
export interface FixtureStats {
  readonly identifier: string;
  readonly a: StatValue[];
  readonly h: StatValue[];
}

/**
 * Stat Value
 */
export interface StatValue {
  readonly value: number;
  readonly element: number;
}

/**
 * Entry (Team)
 */
export interface Entry {
  readonly id: number;
  readonly player_first_name: string;
  readonly player_last_name: string;
  readonly player_region_id: number;
  readonly player_region_name: string;
  readonly player_region_iso_code_short: string;
  readonly player_region_iso_code_long: string;
  readonly started_event: number;
  readonly favourite_team: number;
  readonly player_region_short_iso: string;
  readonly summary_overall_points: number;
  readonly summary_overall_rank: number;
  readonly summary_event_points: number;
  readonly summary_event_rank: number;
  readonly current_event: number;
  readonly leagues: EntryLeagues;
  readonly name: string;
  readonly kit: string;
  readonly last_deadline_bank: number;
  readonly last_deadline_value: number;
  readonly last_deadline_total_transfers: number;
}

/**
 * Entry Leagues
 */
export interface EntryLeagues {
  readonly classic: LeagueSummary[];
  readonly h2h: LeagueSummary[];
  readonly cup: CupSummary;
}

/**
 * League Summary
 */
export interface LeagueSummary {
  readonly id: number;
  readonly name: string;
  readonly short_name: string;
  readonly created: string;
  readonly closed: boolean;
  readonly rank: number | null;
  readonly max_entries: number | null;
  readonly league_type: string;
  readonly scoring: string;
  readonly admin_entry: number | null;
  readonly start_event: number;
  readonly entry_can_leave: boolean;
  readonly entry_can_admin: boolean;
  readonly entry_can_invite: boolean;
}

/**
 * Cup Summary
 */
export interface CupSummary {
  readonly matches: CupMatch[];
  readonly status: {
    readonly qualification_event: number;
    readonly qualification_numbers: number;
    readonly qualification_rank: number;
    readonly qualification_state: string;
  };
}

/**
 * Cup Match
 */
export interface CupMatch {
  readonly id: number;
  readonly entry_1_entry: number;
  readonly entry_1_name: string;
  readonly entry_1_player_name: string;
  readonly entry_1_points: number;
  readonly entry_1_win: number;
  readonly entry_1_draw: number;
  readonly entry_1_loss: number;
  readonly entry_2_entry: number;
  readonly entry_2_name: string;
  readonly entry_2_player_name: string;
  readonly entry_2_points: number;
  readonly entry_2_win: number;
  readonly entry_2_draw: number;
  readonly entry_2_loss: number;
  readonly is_knockout: boolean;
  readonly winner: number;
  readonly seed_value: number | null;
  readonly event: number;
  readonly tiebreak: number | null;
}

/**
 * Entry History
 */
export interface EntryHistory {
  readonly current: HistoryEvent[];
  readonly past: PastSeason[];
  readonly chips: ChipPlay[];
}

/**
 * History Event
 */
export interface HistoryEvent {
  readonly event: number;
  readonly points: number;
  readonly total_points: number;
  readonly rank: number;
  readonly rank_sort: number;
  readonly overall_rank: number;
  readonly bank: number;
  readonly value: number;
  readonly event_transfers: number;
  readonly event_transfers_cost: number;
  readonly points_on_bench: number;
}

/**
 * Past Season
 */
export interface PastSeason {
  readonly season_name: string;
  readonly total_points: number;
  readonly rank: number;
}

/**
 * Element Summary
 */
export interface ElementSummary {
  readonly fixtures: ElementFixture[];
  readonly history: ElementHistory[];
  readonly history_past: ElementHistoryPast[];
}

/**
 * Element Fixture
 */
export interface ElementFixture {
  readonly id: number;
  readonly code: number;
  readonly team_h: number;
  readonly team_h_score: number | null;
  readonly team_a: number;
  readonly team_a_score: number | null;
  readonly event: number;
  readonly finished: boolean;
  readonly minutes: number;
  readonly provisional_start_time: boolean;
  readonly kickoff_time: string;
  readonly event_name: string;
  readonly is_home: boolean;
  readonly difficulty: number;
}

/**
 * Element History
 */
export interface ElementHistory {
  readonly element: number;
  readonly fixture: number;
  readonly opponent_team: number;
  readonly total_points: number;
  readonly was_home: boolean;
  readonly kickoff_time: string;
  readonly team_h_score: number;
  readonly team_a_score: number;
  readonly round: number;
  readonly minutes: number;
  readonly goals_scored: number;
  readonly assists: number;
  readonly clean_sheets: number;
  readonly goals_conceded: number;
  readonly own_goals: number;
  readonly penalties_saved: number;
  readonly penalties_missed: number;
  readonly yellow_cards: number;
  readonly red_cards: number;
  readonly saves: number;
  readonly bonus: number;
  readonly bps: number;
  readonly influence: string;
  readonly creativity: string;
  readonly threat: string;
  readonly ict_index: string;
  readonly value: number;
  readonly transfers_balance: number;
  readonly selected: number;
  readonly transfers_in: number;
  readonly transfers_out: number;
}

/**
 * Element History Past
 */
export interface ElementHistoryPast {
  readonly season_name: string;
  readonly element_code: number;
  readonly start_cost: number;
  readonly end_cost: number;
  readonly total_points: number;
  readonly minutes: number;
  readonly goals_scored: number;
  readonly assists: number;
  readonly clean_sheets: number;
  readonly goals_conceded: number;
  readonly own_goals: number;
  readonly penalties_saved: number;
  readonly penalties_missed: number;
  readonly yellow_cards: number;
  readonly red_cards: number;
  readonly saves: number;
  readonly bonus: number;
  readonly bps: number;
  readonly influence: string;
  readonly creativity: string;
  readonly threat: string;
  readonly ict_index: string;
}

/**
 * Entry Event Picks
 */
export interface EntryEventPicks {
  readonly active_chip: string | null;
  readonly automatic_subs: AutomaticSub[];
  readonly entry_history: HistoryEvent;
  readonly picks: Pick[];
}

/**
 * Automatic Sub
 */
export interface AutomaticSub {
  readonly entry: number;
  readonly element_in: number;
  readonly element_out: number;
  readonly event: number;
}

/**
 * Pick
 */
export interface Pick {
  readonly element: number;
  readonly position: number;
  readonly multiplier: number;
  readonly is_captain: boolean;
  readonly is_vice_captain: boolean;
}

/**
 * Entry Transfer
 */
export interface EntryTransfer {
  readonly element_in: number;
  readonly element_in_cost: number;
  readonly element_out: number;
  readonly element_out_cost: number;
  readonly entry: number;
  readonly event: number;
  readonly time: string;
}

/**
 * League Classic
 */
export interface LeagueClassic {
  readonly league: League;
  readonly new_entries: NewEntry[];
  readonly standings: LeagueStanding[];
}

/**
 * League H2H
 */
export interface LeagueH2H {
  readonly league: League;
  readonly new_entries: NewEntry[];
  readonly standings: H2HStanding[];
}

/**
 * League
 */
export interface League {
  readonly id: number;
  readonly name: string;
  readonly created: string;
  readonly closed: boolean;
  readonly max_entries: number | null;
  readonly league_type: string;
  readonly scoring: string;
  readonly admin_entry: number | null;
  readonly start_event: number;
  readonly code_privacy: string;
  readonly has_cup: boolean;
  readonly cup_league: number | null;
  readonly rank: number | null;
}

/**
 * New Entry
 */
export interface NewEntry {
  readonly entry: number;
  readonly entry_name: string;
  readonly joined_time: string;
  readonly player_first_name: string;
  readonly player_last_name: string;
}

/**
 * League Standing
 */
export interface LeagueStanding {
  readonly entry: number;
  readonly entry_name: string;
  readonly event_total: number;
  readonly id: number;
  readonly last_rank: number;
  readonly player_name: string;
  readonly rank: number;
  readonly rank_sort: number;
  readonly total: number;
}

/**
 * H2H Standing
 */
export interface H2HStanding extends LeagueStanding {
  readonly matches_drawn: number;
  readonly matches_lost: number;
  readonly matches_played: number;
  readonly matches_won: number;
  readonly points_for: number;
}
