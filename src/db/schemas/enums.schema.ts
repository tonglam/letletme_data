import { pgEnum } from 'drizzle-orm/pg-core';

export const chipEnum = pgEnum('chip', ['n/a', 'wildcard', 'freehit', 'bboost', '3xc', 'manager']);

export const valueChangeTypeEnum = pgEnum('value_change_type', ['start', 'rise', 'fall']);

export const leagueTypeEnum = pgEnum('league_type', ['classic', 'h2h']);

export const cupResultEnum = pgEnum('cup_result', ['win', 'loss']);

export const tournamentModeEnum = pgEnum('tournament_mode', ['normal']);

export const groupModeEnum = pgEnum('group_mode', ['no_group', 'points_races', 'battle_races']);

export const knockoutModeEnum = pgEnum('knockout_mode', [
  'no_knockout',
  'single_elimination',
  'double_elimination',
  'head_to_head',
]);

export const tournamentStateEnum = pgEnum('tournament_state', ['active', 'inactive', 'finished']);

export const tournamentSetupStatusEnum = pgEnum('tournament_setup_status', [
  'pending',
  'processing',
  'ready',
  'failed',
]);

export const tournamentSetupPhaseEnum = pgEnum('tournament_setup_phase', [
  'queued',
  'syncing_entries',
  'building_structure',
  'calculating_standings',
  'enriching_history',
  'finalizing',
  'ready',
  'failed',
]);

export const tournamentRosterModeEnum = pgEnum('tournament_roster_mode', [
  'snapshot',
  'official_sync',
]);

export const understatSeasonStateEnum = pgEnum('understat_season_state', [
  'planned',
  'active',
  'complete',
]);

export const understatLaneEnum = pgEnum('understat_lane', ['team', 'player']);

export const understatSyncModeEnum = pgEnum('understat_sync_mode', [
  'incremental',
  'full',
  'reconcile',
]);

export const understatSyncTriggerEnum = pgEnum('understat_sync_trigger', ['cron', 'manual', 'api']);

export const understatSyncRunStatusEnum = pgEnum('understat_sync_run_status', [
  'pending',
  'running',
  'failed',
  'ready_to_publish',
  'published',
]);

export const understatSyncItemStatusEnum = pgEnum('understat_sync_item_status', [
  'pending',
  'running',
  'failed',
  'completed',
  'skipped',
]);

export const providerEntityTypeEnum = pgEnum('provider_entity_type', ['team', 'player']);

export const providerLinkStatusEnum = pgEnum('provider_link_status', [
  'pending',
  'auto_verified',
  'manual_verified',
  'ambiguous',
  'quarantined',
  'rejected',
  'not_observed',
]);
