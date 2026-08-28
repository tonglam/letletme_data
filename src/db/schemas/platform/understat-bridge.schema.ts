// Canonical understat bridge PostgreSQL schema declarations.
import {
  foreignKey,
  unique,
  check,
  text,
  jsonb,
  timestamp,
  index,
  uuid,
  integer,
  boolean,
  uniqueIndex,
  numeric,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  entityTypeInBridge,
  linkStatusInBridge,
  seasonStateInUnderstat,
  understat,
  bridge,
} from './namespaces.schema';

export const entityLinksInBridge = bridge.table(
  'entity_links',
  {
    linkId: uuid('link_id').primaryKey().notNull(),
    entityType: entityTypeInBridge('entity_type').notNull(),
    leftProvider: text('left_provider').notNull(),
    leftEntityId: text('left_entity_id'),
    rightProvider: text('right_provider').notNull(),
    rightEntityId: text('right_entity_id').notNull(),
    status: linkStatusInBridge().notNull(),
    method: text().notNull(),
    ruleId: text('rule_id').notNull(),
    evidence: jsonb().default({}).notNull(),
    firstSeenSeason: text('first_seen_season'),
    lastSeenSeason: text('last_seen_season'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('bridge_entity_links_status_idx').using(
      'btree',
      table.entityType.asc().nullsLast(),
      table.status.asc().nullsLast(),
      table.lastSeenSeason.asc().nullsLast(),
    ),
    uniqueIndex('bridge_entity_links_verified_left_idx')
      .using(
        'btree',
        table.entityType.asc().nullsLast(),
        table.leftProvider.asc().nullsLast(),
        table.leftEntityId.asc().nullsLast(),
      )
      .where(
        sql`(status = ANY (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status]))`,
      ),
    uniqueIndex('bridge_entity_links_verified_right_idx')
      .using(
        'btree',
        table.entityType.asc().nullsLast(),
        table.rightProvider.asc().nullsLast(),
        table.rightEntityId.asc().nullsLast(),
      )
      .where(
        sql`(status = ANY (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status]))`,
      ),
    unique('bridge_entity_links_pair_unique')
      .on(
        table.entityType,
        table.leftProvider,
        table.leftEntityId,
        table.rightProvider,
        table.rightEntityId,
      )
      .nullsNotDistinct(),
    check('bridge_entity_links_distinct_providers', sql`left_provider <> right_provider`),
    check(
      'bridge_entity_links_required_fields_nonempty',
      sql`(btrim(left_provider) <> ''::text) AND (btrim(right_provider) <> ''::text) AND (btrim(right_entity_id) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(rule_id) <> ''::text)`,
    ),
    check(
      'bridge_entity_links_verified_complete',
      sql`(status <> ALL (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status])) OR ((left_entity_id IS NOT NULL) AND (btrim(left_entity_id) <> ''::text))`,
    ),
    check('bridge_entity_links_evidence_object', sql`jsonb_typeof(evidence) = 'object'::text`),
    check(
      'bridge_entity_links_season_order',
      sql`(last_seen_season IS NULL) OR (first_seen_season IS NULL) OR (last_seen_season >= first_seen_season)`,
    ),
  ],
);

export const matchLinksInBridge = bridge.table(
  'match_links',
  {
    linkId: uuid('link_id').primaryKey().notNull(),
    seasonCode: text('season_code').notNull(),
    leftProvider: text('left_provider').notNull(),
    leftMatchId: text('left_match_id').notNull(),
    rightProvider: text('right_provider').notNull(),
    rightMatchId: text('right_match_id').notNull(),
    status: linkStatusInBridge().notNull(),
    method: text().notNull(),
    ruleId: text('rule_id').notNull(),
    evidence: jsonb().default({}).notNull(),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('bridge_match_links_status_idx').using(
      'btree',
      table.seasonCode.asc().nullsLast(),
      table.status.asc().nullsLast(),
    ),
    uniqueIndex('bridge_match_links_verified_left_idx')
      .using(
        'btree',
        table.seasonCode.asc().nullsLast(),
        table.leftProvider.asc().nullsLast(),
        table.leftMatchId.asc().nullsLast(),
      )
      .where(
        sql`(status = ANY (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status]))`,
      ),
    uniqueIndex('bridge_match_links_verified_right_idx')
      .using(
        'btree',
        table.seasonCode.asc().nullsLast(),
        table.rightProvider.asc().nullsLast(),
        table.rightMatchId.asc().nullsLast(),
      )
      .where(
        sql`(status = ANY (ARRAY['auto_verified'::bridge.link_status, 'manual_verified'::bridge.link_status]))`,
      ),
    unique('bridge_match_links_pair_unique').on(
      table.seasonCode,
      table.leftProvider,
      table.leftMatchId,
      table.rightProvider,
      table.rightMatchId,
    ),
    check('bridge_match_links_season_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check('bridge_match_links_distinct_providers', sql`left_provider <> right_provider`),
    check(
      'bridge_match_links_required_fields_nonempty',
      sql`(btrim(left_provider) <> ''::text) AND (btrim(left_match_id) <> ''::text) AND (btrim(right_provider) <> ''::text) AND (btrim(right_match_id) <> ''::text) AND (btrim(method) <> ''::text) AND (btrim(rule_id) <> ''::text)`,
    ),
    check('bridge_match_links_evidence_object', sql`jsonb_typeof(evidence) = 'object'::text`),
  ],
);

export const entityAliasesInBridge = bridge.table(
  'entity_aliases',
  {
    aliasId: uuid('alias_id').primaryKey().notNull(),
    entityType: entityTypeInBridge('entity_type').notNull(),
    provider: text().notNull(),
    providerEntityId: text('provider_entity_id').notNull(),
    alias: text().notNull(),
    source: text().notNull(),
    firstObservedAt: timestamp('first_observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('bridge_entity_aliases_lookup_idx').using(
      'btree',
      table.entityType.asc().nullsLast(),
      table.provider.asc().nullsLast(),
      table.alias.asc().nullsLast(),
    ),
    unique('bridge_entity_aliases_business_unique').on(
      table.entityType,
      table.provider,
      table.providerEntityId,
      table.alias,
      table.source,
    ),
    check(
      'bridge_entity_aliases_fields_nonempty',
      sql`(btrim(provider) <> ''::text) AND (btrim(provider_entity_id) <> ''::text) AND (btrim(alias) <> ''::text) AND (btrim(source) <> ''::text)`,
    ),
    check('bridge_entity_aliases_observed_order', sql`last_observed_at >= first_observed_at`),
  ],
);

export const seasonsInUnderstat = understat.table(
  'seasons',
  {
    seasonCode: text('season_code').primaryKey().notNull(),
    sourceYear: integer('source_year').notNull(),
    league: text().notNull(),
    state: seasonStateInUnderstat().notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('seasons_source_year_key').on(table.sourceYear),
    check('understat_seasons_code_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check(
      'understat_seasons_source_year_valid',
      sql`(source_year >= 2000) AND (source_year <= 2100)`,
    ),
    check('understat_seasons_league_nonempty', sql`btrim(league) <> ''::text`),
    check('understat_seasons_seen_order', sql`last_seen_at >= first_seen_at`),
  ],
);

export const teamsInUnderstat = understat.table(
  'teams',
  {
    teamId: integer('team_id').primaryKey().notNull(),
    title: text().notNull(),
    shortTitle: text('short_title'),
    firstSeenSeason: text('first_seen_season').notNull(),
    lastSeenSeason: text('last_seen_season').notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('understat_teams_first_season_fk_idx').using(
      'btree',
      table.firstSeenSeason.asc().nullsLast(),
    ),
    index('understat_teams_last_season_fk_idx').using(
      'btree',
      table.lastSeenSeason.asc().nullsLast(),
    ),
    index('understat_teams_title_idx').using('btree', table.title.asc().nullsLast()),
    foreignKey({
      columns: [table.firstSeenSeason],
      foreignColumns: [seasonsInUnderstat.seasonCode],
      name: 'understat_teams_first_season_fk',
    }),
    foreignKey({
      columns: [table.lastSeenSeason],
      foreignColumns: [seasonsInUnderstat.seasonCode],
      name: 'understat_teams_last_season_fk',
    }),
    check('understat_teams_id_positive', sql`team_id > 0`),
    check('understat_teams_title_nonempty', sql`btrim(title) <> ''::text`),
    check(
      'understat_teams_season_format',
      sql`(first_seen_season ~ '^[0-9]{4}$'::text) AND (last_seen_season ~ '^[0-9]{4}$'::text)`,
    ),
    check('understat_teams_season_order', sql`last_seen_season >= first_seen_season`),
    check('understat_teams_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
  ],
);

export const playersInUnderstat = understat.table(
  'players',
  {
    playerId: integer('player_id').primaryKey().notNull(),
    name: text().notNull(),
    favoritePosition: text('favorite_position'),
    firstSeenSeason: text('first_seen_season').notNull(),
    lastSeenSeason: text('last_seen_season').notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('understat_players_first_season_fk_idx').using(
      'btree',
      table.firstSeenSeason.asc().nullsLast(),
    ),
    index('understat_players_last_season_fk_idx').using(
      'btree',
      table.lastSeenSeason.asc().nullsLast(),
    ),
    index('understat_players_name_idx').using('btree', table.name.asc().nullsLast()),
    foreignKey({
      columns: [table.firstSeenSeason],
      foreignColumns: [seasonsInUnderstat.seasonCode],
      name: 'understat_players_first_season_fk',
    }),
    foreignKey({
      columns: [table.lastSeenSeason],
      foreignColumns: [seasonsInUnderstat.seasonCode],
      name: 'understat_players_last_season_fk',
    }),
    check('understat_players_id_positive', sql`player_id > 0`),
    check('understat_players_name_nonempty', sql`btrim(name) <> ''::text`),
    check(
      'understat_players_season_format',
      sql`(first_seen_season ~ '^[0-9]{4}$'::text) AND (last_seen_season ~ '^[0-9]{4}$'::text)`,
    ),
    check('understat_players_season_order', sql`last_seen_season >= first_seen_season`),
    check('understat_players_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
  ],
);

export const matchesInUnderstat = understat.table(
  'matches',
  {
    matchId: integer('match_id').primaryKey().notNull(),
    seasonCode: text('season_code').notNull(),
    homeTeamId: integer('home_team_id').notNull(),
    awayTeamId: integer('away_team_id').notNull(),
    kickoffAt: timestamp('kickoff_at', { withTimezone: true, mode: 'date' }).notNull(),
    isResult: boolean('is_result').default(false).notNull(),
    homeGoals: integer('home_goals'),
    awayGoals: integer('away_goals'),
    homeXg: numeric('home_xg', { mode: 'number' }),
    awayXg: numeric('away_xg', { mode: 'number' }),
    forecastHomeWin: numeric('forecast_home_win', { mode: 'number' }),
    forecastDraw: numeric('forecast_draw', { mode: 'number' }),
    forecastAwayWin: numeric('forecast_away_win', { mode: 'number' }),
    sourceHash: text('source_hash').notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('understat_matches_away_team_idx').using(
      'btree',
      table.awayTeamId.asc().nullsLast(),
      table.seasonCode.asc().nullsLast(),
      table.kickoffAt.asc().nullsLast(),
    ),
    index('understat_matches_home_team_idx').using(
      'btree',
      table.homeTeamId.asc().nullsLast(),
      table.seasonCode.asc().nullsLast(),
      table.kickoffAt.asc().nullsLast(),
    ),
    index('understat_matches_season_kickoff_idx').using(
      'btree',
      table.seasonCode.asc().nullsLast(),
      table.kickoffAt.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.awayTeamId],
      foreignColumns: [teamsInUnderstat.teamId],
      name: 'understat_matches_away_team_fk',
    }),
    foreignKey({
      columns: [table.homeTeamId],
      foreignColumns: [teamsInUnderstat.teamId],
      name: 'understat_matches_home_team_fk',
    }),
    foreignKey({
      columns: [table.seasonCode],
      foreignColumns: [seasonsInUnderstat.seasonCode],
      name: 'understat_matches_season_fk',
    }),
    check('understat_matches_id_positive', sql`match_id > 0`),
    check('understat_matches_season_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check('understat_matches_distinct_teams', sql`home_team_id <> away_team_id`),
    check(
      'understat_matches_goals_nonnegative',
      sql`((home_goals IS NULL) OR (home_goals >= 0)) AND ((away_goals IS NULL) OR (away_goals >= 0))`,
    ),
    check(
      'understat_matches_forecast_range',
      sql`((forecast_home_win IS NULL) OR ((forecast_home_win >= (0)::numeric) AND (forecast_home_win <= (1)::numeric))) AND ((forecast_draw IS NULL) OR ((forecast_draw >= (0)::numeric) AND (forecast_draw <= (1)::numeric))) AND ((forecast_away_win IS NULL) OR ((forecast_away_win >= (0)::numeric) AND (forecast_away_win <= (1)::numeric)))`,
    ),
    check('understat_matches_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
    check('understat_matches_seen_order', sql`last_seen_at >= source_checked_at`),
  ],
);

export const playerMatchStatsInUnderstat = understat.table(
  'player_match_stats',
  {
    rosterId: integer('roster_id').primaryKey().notNull(),
    matchId: integer('match_id').notNull(),
    playerId: integer('player_id').notNull(),
    teamId: integer('team_id').notNull(),
    playerName: text('player_name').notNull(),
    side: text().notNull(),
    position: text().notNull(),
    positionOrder: integer('position_order').notNull(),
    minutes: integer().notNull(),
    started: boolean().notNull(),
    goals: integer().notNull(),
    ownGoals: integer('own_goals').notNull(),
    shots: integer().notNull(),
    keyPasses: integer('key_passes').notNull(),
    assists: integer().notNull(),
    yellowCards: integer('yellow_cards').notNull(),
    redCards: integer('red_cards').notNull(),
    xg: numeric('xg', { mode: 'number' }).notNull(),
    xa: numeric('xa', { mode: 'number' }).notNull(),
    xgChain: numeric('xg_chain', { mode: 'number' }).notNull(),
    xgBuildup: numeric('xg_buildup', { mode: 'number' }).notNull(),
    rosterInId: integer('roster_in_id'),
    rosterOutId: integer('roster_out_id'),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('understat_player_match_stats_match_idx').using(
      'btree',
      table.matchId.asc().nullsLast(),
      table.teamId.asc().nullsLast(),
      table.playerId.asc().nullsLast(),
    ),
    index('understat_player_match_stats_player_idx').using(
      'btree',
      table.playerId.asc().nullsLast(),
      table.matchId.asc().nullsLast(),
    ),
    index('understat_player_match_stats_roster_in_fk_idx').using(
      'btree',
      table.rosterInId.asc().nullsLast(),
    ),
    index('understat_player_match_stats_roster_out_fk_idx').using(
      'btree',
      table.rosterOutId.asc().nullsLast(),
    ),
    index('understat_player_match_stats_team_idx').using(
      'btree',
      table.teamId.asc().nullsLast(),
      table.matchId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.matchId],
      foreignColumns: [matchesInUnderstat.matchId],
      name: 'understat_player_match_stats_match_fk',
    }),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [playersInUnderstat.playerId],
      name: 'understat_player_match_stats_player_fk',
    }),
    foreignKey({
      columns: [table.rosterInId],
      foreignColumns: [table.rosterId],
      name: 'understat_player_match_stats_roster_in_fk',
    }),
    foreignKey({
      columns: [table.rosterOutId],
      foreignColumns: [table.rosterId],
      name: 'understat_player_match_stats_roster_out_fk',
    }),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teamsInUnderstat.teamId],
      name: 'understat_player_match_stats_team_fk',
    }),
    check('understat_player_match_stats_side_valid', sql`side = ANY (ARRAY['h'::text, 'a'::text])`),
    check(
      'understat_player_match_stats_ids_positive',
      sql`(roster_id > 0) AND (match_id > 0) AND (player_id > 0) AND (team_id > 0)`,
    ),
    check(
      'understat_player_match_stats_names_nonempty',
      sql`(btrim(player_name) <> ''::text) AND (btrim("position") <> ''::text)`,
    ),
    check(
      'understat_player_match_stats_counts_nonnegative',
      sql`(position_order >= 0) AND (minutes >= 0) AND (goals >= 0) AND (own_goals >= 0) AND (shots >= 0) AND (key_passes >= 0) AND (assists >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0)`,
    ),
    check('understat_player_match_stats_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
  ],
);

export const teamStatSplitsInUnderstat = understat.table(
  'team_stat_splits',
  {
    seasonCode: text('season_code').notNull(),
    teamId: integer('team_id').notNull(),
    dimension: text().notNull(),
    splitKey: text('split_key').notNull(),
    label: text(),
    timeMinutes: integer('time_minutes'),
    shotsFor: integer('shots_for').notNull(),
    goalsFor: integer('goals_for').notNull(),
    xgFor: numeric('xg_for', { mode: 'number' }).notNull(),
    shotsAgainst: integer('shots_against').notNull(),
    goalsAgainst: integer('goals_against').notNull(),
    xgAgainst: numeric('xg_against', { mode: 'number' }).notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('understat_team_stat_splits_team_idx').using(
      'btree',
      table.teamId.asc().nullsLast(),
      table.seasonCode.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonCode, table.teamId],
      foreignColumns: [teamSeasonsInUnderstat.seasonCode, teamSeasonsInUnderstat.teamId],
      name: 'understat_team_stat_splits_parent_fk',
    }),
    primaryKey({
      columns: [table.seasonCode, table.teamId, table.dimension, table.splitKey],
      name: 'understat_team_stat_splits_pkey',
    }),
    check('understat_team_stat_splits_season_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check(
      'understat_team_stat_splits_keys_nonempty',
      sql`(btrim(dimension) <> ''::text) AND (btrim(split_key) <> ''::text)`,
    ),
    check(
      'understat_team_stat_splits_counts_nonnegative',
      sql`((time_minutes IS NULL) OR (time_minutes >= 0)) AND (shots_for >= 0) AND (goals_for >= 0) AND (shots_against >= 0) AND (goals_against >= 0)`,
    ),
    check('understat_team_stat_splits_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
  ],
);

export const playerTeamSeasonsInUnderstat = understat.table(
  'player_team_seasons',
  {
    seasonCode: text('season_code').notNull(),
    playerId: integer('player_id').notNull(),
    teamId: integer('team_id').notNull(),
    games: integer().notNull(),
    timeMinutes: integer('time_minutes').notNull(),
    goals: integer().notNull(),
    nonPenaltyGoals: integer('non_penalty_goals').notNull(),
    assists: integer().notNull(),
    shots: integer().notNull(),
    keyPasses: integer('key_passes').notNull(),
    yellowCards: integer('yellow_cards').notNull(),
    redCards: integer('red_cards').notNull(),
    xg: numeric('xg', { mode: 'number' }).notNull(),
    nonPenaltyXg: numeric('non_penalty_xg', { mode: 'number' }).notNull(),
    xa: numeric('xa', { mode: 'number' }).notNull(),
    xgChain: numeric('xg_chain', { mode: 'number' }).notNull(),
    xgBuildup: numeric('xg_buildup', { mode: 'number' }).notNull(),
    position: text().notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('understat_player_team_seasons_team_idx').using(
      'btree',
      table.teamId.asc().nullsLast(),
      table.seasonCode.asc().nullsLast(),
    ),
    index('understat_player_team_season_fk_idx').using('btree', table.seasonCode.asc().nullsLast()),
    foreignKey({
      columns: [table.seasonCode],
      foreignColumns: [seasonsInUnderstat.seasonCode],
      name: 'understat_player_team_season_fk',
    }),
    foreignKey({
      columns: [table.seasonCode, table.playerId],
      foreignColumns: [playerSeasonsInUnderstat.seasonCode, playerSeasonsInUnderstat.playerId],
      name: 'understat_player_team_player_season_fk',
    }),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teamsInUnderstat.teamId],
      name: 'understat_player_team_team_fk',
    }),
    primaryKey({
      columns: [table.seasonCode, table.playerId, table.teamId],
      name: 'understat_player_team_seasons_pkey',
    }),
    check('understat_player_team_seasons_season_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check(
      'understat_player_team_seasons_counts_nonnegative',
      sql`(games >= 0) AND (time_minutes >= 0) AND (goals >= 0) AND (non_penalty_goals >= 0) AND (assists >= 0) AND (shots >= 0) AND (key_passes >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0)`,
    ),
    check('understat_player_team_seasons_position_nonempty', sql`btrim("position") <> ''::text`),
    check(
      'understat_player_team_seasons_source_hash_nonempty',
      sql`btrim(source_hash) <> ''::text`,
    ),
  ],
);

export const playerSeasonsInUnderstat = understat.table(
  'player_seasons',
  {
    seasonCode: text('season_code').notNull(),
    playerId: integer('player_id').notNull(),
    sourceName: text('source_name').notNull(),
    sourceTeamTitle: text('source_team_title').notNull(),
    games: integer().notNull(),
    timeMinutes: integer('time_minutes').notNull(),
    goals: integer().notNull(),
    nonPenaltyGoals: integer('non_penalty_goals').notNull(),
    assists: integer().notNull(),
    shots: integer().notNull(),
    keyPasses: integer('key_passes').notNull(),
    yellowCards: integer('yellow_cards').notNull(),
    redCards: integer('red_cards').notNull(),
    xg: numeric('xg', { mode: 'number' }).notNull(),
    nonPenaltyXg: numeric('non_penalty_xg', { mode: 'number' }).notNull(),
    xa: numeric('xa', { mode: 'number' }).notNull(),
    xgChain: numeric('xg_chain', { mode: 'number' }).notNull(),
    xgBuildup: numeric('xg_buildup', { mode: 'number' }).notNull(),
    position: text().notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('understat_player_seasons_player_idx').using(
      'btree',
      table.playerId.asc().nullsLast(),
      table.seasonCode.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.playerId],
      foreignColumns: [playersInUnderstat.playerId],
      name: 'understat_player_seasons_player_fk',
    }),
    foreignKey({
      columns: [table.seasonCode],
      foreignColumns: [seasonsInUnderstat.seasonCode],
      name: 'understat_player_seasons_season_fk',
    }),
    primaryKey({
      columns: [table.seasonCode, table.playerId],
      name: 'understat_player_seasons_pkey',
    }),
    check('understat_player_seasons_season_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check(
      'understat_player_seasons_names_nonempty',
      sql`(btrim(source_name) <> ''::text) AND (btrim(source_team_title) <> ''::text) AND (btrim("position") <> ''::text)`,
    ),
    check(
      'understat_player_seasons_counts_nonnegative',
      sql`(games >= 0) AND (time_minutes >= 0) AND (goals >= 0) AND (non_penalty_goals >= 0) AND (assists >= 0) AND (shots >= 0) AND (key_passes >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0)`,
    ),
    check('understat_player_seasons_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
  ],
);

export const teamMatchStatsInUnderstat = understat.table(
  'team_match_stats',
  {
    matchId: integer('match_id').notNull(),
    teamId: integer('team_id').notNull(),
    side: text().notNull(),
    xg: numeric('xg', { mode: 'number' }).notNull(),
    xga: numeric('xga', { mode: 'number' }).notNull(),
    npxg: numeric('npxg', { mode: 'number' }).notNull(),
    npxga: numeric('npxga', { mode: 'number' }).notNull(),
    npxgd: numeric('npxgd', { mode: 'number' }).notNull(),
    ppdaAtt: integer('ppda_att').notNull(),
    ppdaDef: integer('ppda_def').notNull(),
    ppdaAllowedAtt: integer('ppda_allowed_att').notNull(),
    ppdaAllowedDef: integer('ppda_allowed_def').notNull(),
    deep: integer().notNull(),
    deepAllowed: integer('deep_allowed').notNull(),
    scored: integer().notNull(),
    missed: integer().notNull(),
    xpoints: numeric('xpoints', { mode: 'number' }).notNull(),
    result: text().notNull(),
    points: integer().notNull(),
    wins: integer().notNull(),
    draws: integer().notNull(),
    losses: integer().notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('understat_team_match_stats_team_idx').using(
      'btree',
      table.teamId.asc().nullsLast(),
      table.matchId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.matchId],
      foreignColumns: [matchesInUnderstat.matchId],
      name: 'understat_team_match_stats_match_fk',
    }),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teamsInUnderstat.teamId],
      name: 'understat_team_match_stats_team_fk',
    }),
    primaryKey({ columns: [table.matchId, table.teamId], name: 'understat_team_match_stats_pkey' }),
    check('understat_team_match_stats_side_valid', sql`side = ANY (ARRAY['h'::text, 'a'::text])`),
    check(
      'understat_team_match_stats_result_valid',
      sql`result = ANY (ARRAY['w'::text, 'd'::text, 'l'::text])`,
    ),
    check(
      'understat_team_match_stats_counts_nonnegative',
      sql`(ppda_att >= 0) AND (ppda_def >= 0) AND (ppda_allowed_att >= 0) AND (ppda_allowed_def >= 0) AND (deep >= 0) AND (deep_allowed >= 0) AND (scored >= 0) AND (missed >= 0) AND (points >= 0) AND (wins >= 0) AND (draws >= 0) AND (losses >= 0)`,
    ),
    check('understat_team_match_stats_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
  ],
);

export const teamSeasonsInUnderstat = understat.table(
  'team_seasons',
  {
    seasonCode: text('season_code').notNull(),
    teamId: integer('team_id').notNull(),
    sourceTitle: text('source_title').notNull(),
    sourceShortTitle: text('source_short_title'),
    games: integer().notNull(),
    wins: integer().notNull(),
    draws: integer().notNull(),
    losses: integer().notNull(),
    goalsFor: integer('goals_for').notNull(),
    goalsAgainst: integer('goals_against').notNull(),
    points: integer().notNull(),
    xg: numeric('xg', { mode: 'number' }).notNull(),
    xga: numeric('xga', { mode: 'number' }).notNull(),
    npxg: numeric('npxg', { mode: 'number' }).notNull(),
    npxga: numeric('npxga', { mode: 'number' }).notNull(),
    npxgd: numeric('npxgd', { mode: 'number' }).notNull(),
    xpoints: numeric('xpoints', { mode: 'number' }).notNull(),
    deep: integer().notNull(),
    deepAllowed: integer('deep_allowed').notNull(),
    ppdaAtt: integer('ppda_att').notNull(),
    ppdaDef: integer('ppda_def').notNull(),
    ppdaAllowedAtt: integer('ppda_allowed_att').notNull(),
    ppdaAllowedDef: integer('ppda_allowed_def').notNull(),
    sourceHash: text('source_hash').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('understat_team_seasons_team_idx').using(
      'btree',
      table.teamId.asc().nullsLast(),
      table.seasonCode.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonCode],
      foreignColumns: [seasonsInUnderstat.seasonCode],
      name: 'understat_team_seasons_season_fk',
    }),
    foreignKey({
      columns: [table.teamId],
      foreignColumns: [teamsInUnderstat.teamId],
      name: 'understat_team_seasons_team_fk',
    }),
    primaryKey({ columns: [table.seasonCode, table.teamId], name: 'understat_team_seasons_pkey' }),
    check('understat_team_seasons_season_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check(
      'understat_team_seasons_counts_nonnegative',
      sql`(games >= 0) AND (wins >= 0) AND (draws >= 0) AND (losses >= 0) AND (goals_for >= 0) AND (goals_against >= 0) AND (points >= 0) AND (deep >= 0) AND (deep_allowed >= 0) AND (ppda_att >= 0) AND (ppda_def >= 0) AND (ppda_allowed_att >= 0) AND (ppda_allowed_def >= 0)`,
    ),
    check('understat_team_seasons_title_nonempty', sql`btrim(source_title) <> ''::text`),
    check('understat_team_seasons_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
  ],
);
