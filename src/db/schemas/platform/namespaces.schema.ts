/**
 * PostgreSQL namespaces, enums and shared sequences.
 *
 * Table declarations live in the feature schemas. Keeping the namespace
 * objects in one dependency-light module makes the ownership boundaries
 * explicit while preserving every Drizzle export and SQL identifier.
 */
import { pgSchema } from 'drizzle-orm/pg-core';

export const ops = pgSchema('ops');
export const fpl = pgSchema('fpl');
export const competition = pgSchema('competition');
export const understat = pgSchema('understat');
export const bridge = pgSchema('bridge');
export const reporting = pgSchema('reporting');

export const entityTypeInBridge = bridge.enum('entity_type', ['team', 'player']);
export const linkStatusInBridge = bridge.enum('link_status', [
  'pending',
  'auto_verified',
  'manual_verified',
  'ambiguous',
  'quarantined',
  'rejected',
]);
export const chipInCompetition = competition.enum('chip', [
  'n/a',
  'wildcard',
  'freehit',
  'bboost',
  '3xc',
  'manager',
]);
export const cupResultInCompetition = competition.enum('cup_result', ['win', 'loss']);
export const groupModeInCompetition = competition.enum('group_mode', [
  'no_group',
  'points_races',
  'battle_races',
]);
export const knockoutModeInCompetition = competition.enum('knockout_mode', [
  'no_knockout',
  'single_elimination',
  'double_elimination',
  'head_to_head',
]);
export const leagueTypeInCompetition = competition.enum('league_type', ['classic', 'h2h']);
export const officialLeagueKindInCompetition = competition.enum('official_league_kind', [
  's',
  'x',
  'c',
]);
export const tournamentModeInCompetition = competition.enum('tournament_mode', ['normal']);
export const tournamentRosterModeInCompetition = competition.enum('tournament_roster_mode', [
  'snapshot',
  'official_sync',
]);
export const tournamentSetupPhaseInCompetition = competition.enum('tournament_setup_phase', [
  'queued',
  'syncing_entries',
  'building_structure',
  'calculating_standings',
  'enriching_history',
  'finalizing',
  'ready',
  'failed',
]);
export const tournamentSetupStatusInCompetition = competition.enum('tournament_setup_status', [
  'pending',
  'processing',
  'ready',
  'failed',
]);
export const tournamentStateInCompetition = competition.enum('tournament_state', [
  'active',
  'inactive',
  'finished',
]);
export const seasonStateInUnderstat = understat.enum('season_state', [
  'planned',
  'active',
  'complete',
]);
