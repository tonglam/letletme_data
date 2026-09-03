// Canonical reporting PostgreSQL schema declarations.
import {
  foreignKey,
  unique,
  check,
  smallint,
  text,
  timestamp,
  index,
  integer,
  boolean,
  uniqueIndex,
  bigint,
  date,
  numeric,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { chipInCompetition, reporting } from './namespaces.schema';
import { seasonsInFpl, playersInFpl, eventsInFpl } from './fpl.schema';
import { tournamentsInCompetition } from './competition.schema';
import { playerSeasonsInUnderstat } from './understat-bridge.schema';

export const tournamentSelectionStatPublicationsInReporting = reporting.table(
  'tournament_selection_stat_publications',
  {
    publicationId: bigint('publication_id', { mode: 'number' })
      .generatedAlwaysAsIdentity()
      .primaryKey()
      .notNull(),
    seasonId: smallint('season_id').notNull(),
    tournamentId: integer('tournament_id').notNull(),
    eventId: integer('event_id').notNull(),
    revision: bigint({ mode: 'number' }).notNull(),
    publicationState: text('publication_state').default('COLLECTING').notNull(),
    isActive: boolean('is_active').default(false).notNull(),
    methodKey: text('method_key').default('exact_prepared_competition').notNull(),
    methodVersion: text('method_version').default('1').notNull(),
    sourcePolicyVersion: text('source_policy_version').default('1').notNull(),
    sourceWatermark: timestamp('source_watermark', { withTimezone: true, mode: 'date' }),
    sourceChecksum: text('source_checksum'),
    expectedEntries: integer('expected_entries').default(0).notNull(),
    completePickEntries: integer('complete_pick_entries').default(0).notNull(),
    transferCheckpointEntries: integer('transfer_checkpoint_entries').default(0).notNull(),
    ownershipState: text('ownership_state').default('NOT_READY').notNull(),
    captaincyState: text('captaincy_state').default('NOT_READY').notNull(),
    viceCaptaincyState: text('vice_captaincy_state').default('NOT_READY').notNull(),
    transfersState: text('transfers_state').default('NOT_READY').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('tournament_selection_stat_publications_scope_revision_unique').on(
      table.seasonId,
      table.tournamentId,
      table.eventId,
      table.revision,
    ),
    index('tournament_selection_stat_publications_catalog_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
      table.publicationState.asc().nullsLast(),
      table.publishedAt.desc().nullsLast(),
    ),
    uniqueIndex('tournament_selection_stat_publications_active_scope_idx')
      .using(
        'btree',
        table.seasonId.asc().nullsLast(),
        table.tournamentId.asc().nullsLast(),
        table.eventId.asc().nullsLast(),
      )
      .where(sql`is_active`),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'tournament_selection_stat_publications_scope_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournament_selection_stat_publications_event_fk',
    }),
    check(
      'tournament_selection_stat_publications_ids_positive',
      sql`(tournament_id > 0) AND (event_id BETWEEN 1 AND 38) AND (revision > 0)`,
    ),
    check(
      'tournament_selection_stat_publications_counts_nonnegative',
      sql`(expected_entries >= 0) AND (complete_pick_entries >= 0) AND (transfer_checkpoint_entries >= 0)`,
    ),
    check(
      'tournament_selection_stat_publications_state_check',
      sql`publication_state IN ('COLLECTING', 'READY', 'FAILED', 'UNSUPPORTED')`,
    ),
    check(
      'tournament_selection_stat_publications_capability_state_check',
      sql`(ownership_state IN ('READY', 'NOT_READY', 'FAILED', 'UNSUPPORTED'))
        AND (captaincy_state IN ('READY', 'NOT_READY', 'FAILED', 'UNSUPPORTED'))
        AND (vice_captaincy_state IN ('READY', 'NOT_READY', 'FAILED', 'UNSUPPORTED'))
        AND (transfers_state IN ('READY', 'NOT_READY', 'FAILED', 'UNSUPPORTED'))`,
    ),
  ],
);

export const tournamentSelectionStatRowsInReporting = reporting.table(
  'tournament_selection_stat_rows',
  {
    publicationId: bigint('publication_id', { mode: 'number' }).notNull(),
    elementId: integer('element_id').notNull(),
    selectedCount: integer('selected_count').default(0).notNull(),
    effectiveSelectionCount: integer('effective_selection_count').default(0).notNull(),
    captainCount: integer('captain_count').default(0).notNull(),
    viceCaptainCount: integer('vice_captain_count').default(0).notNull(),
    transferInCount: integer('transfer_in_count'),
    transferOutCount: integer('transfer_out_count'),
    playerName: text('player_name').notNull(),
    playerPosition: integer('player_position').notNull(),
    teamShortName: text('team_short_name').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.publicationId, table.elementId],
      name: 'tournament_selection_stat_rows_pkey',
    }),
    foreignKey({
      columns: [table.publicationId],
      foreignColumns: [tournamentSelectionStatPublicationsInReporting.publicationId],
      name: 'tournament_selection_stat_rows_publication_fk',
    }).onDelete('cascade'),
    index('tournament_selection_stat_rows_ownership_idx').using(
      'btree',
      table.publicationId.asc().nullsLast(),
      table.selectedCount.desc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    index('tournament_selection_stat_rows_effective_ownership_idx').using(
      'btree',
      table.publicationId.asc().nullsLast(),
      table.effectiveSelectionCount.desc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    index('tournament_selection_stat_rows_captaincy_idx').using(
      'btree',
      table.publicationId.asc().nullsLast(),
      table.captainCount.desc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    index('tournament_selection_stat_rows_vice_captaincy_idx').using(
      'btree',
      table.publicationId.asc().nullsLast(),
      table.viceCaptainCount.desc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    index('tournament_selection_stat_rows_transfer_in_idx').using(
      'btree',
      table.publicationId.asc().nullsLast(),
      table.transferInCount.desc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    index('tournament_selection_stat_rows_transfer_out_idx').using(
      'btree',
      table.publicationId.asc().nullsLast(),
      table.transferOutCount.desc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    check('tournament_selection_stat_rows_element_id_positive', sql`element_id > 0`),
    check(
      'tournament_selection_stat_rows_counts_nonnegative',
      sql`selected_count >= 0
        AND effective_selection_count >= 0
        AND captain_count >= 0
        AND vice_captain_count >= 0
        AND (transfer_in_count IS NULL OR transfer_in_count >= 0)
        AND (transfer_out_count IS NULL OR transfer_out_count >= 0)`,
    ),
    check('tournament_selection_stat_rows_player_name_nonempty', sql`btrim(player_name) <> ''`),
    check('tournament_selection_stat_rows_team_name_nonempty', sql`btrim(team_short_name) <> ''`),
  ],
);

export const playerSeasonSummaryRowsInReporting = reporting.table(
  'player_season_summary_rows',
  {
    seasonId: smallint('season_id').notNull(),
    elementId: integer('element_id').notNull(),
    elementType: integer('element_type').notNull(),
    gameweeksAvailable: integer('gameweeks_available').notNull(),
    gameweeksStarted: integer('gameweeks_started').notNull(),
    minutes: integer().notNull(),
    goalsScored: integer('goals_scored').notNull(),
    assists: integer().notNull(),
    cleanSheets: integer('clean_sheets').notNull(),
    goalsConceded: integer('goals_conceded').notNull(),
    ownGoals: integer('own_goals').notNull(),
    penaltiesSaved: integer('penalties_saved').notNull(),
    penaltiesMissed: integer('penalties_missed').notNull(),
    yellowCards: integer('yellow_cards').notNull(),
    redCards: integer('red_cards').notNull(),
    saves: integer().notNull(),
    bonus: integer().notNull(),
    bps: integer().notNull(),
    totalPoints: integer('total_points').notNull(),
    defensiveContribution: integer('defensive_contribution').notNull(),
    expectedGoals: numeric('expected_goals').notNull(),
    expectedAssists: numeric('expected_assists').notNull(),
    expectedGoalInvolvements: numeric('expected_goal_involvements').notNull(),
    expectedGoalsConceded: numeric('expected_goals_conceded').notNull(),
    dreamTeamAppearances: integer('dream_team_appearances').notNull(),
    returnCount: integer('return_count').notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('player_season_summary_rows_cohort_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementType.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_season_summary_rows_player_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.elementId],
      name: 'player_season_summary_rows_pkey',
    }),
    check(
      'player_season_summary_rows_counts_nonnegative',
      sql`(gameweeks_available >= 0) AND (gameweeks_started >= 0) AND (minutes >= 0) AND (goals_scored >= 0) AND (assists >= 0) AND (clean_sheets >= 0) AND (goals_conceded >= 0) AND (own_goals >= 0) AND (penalties_saved >= 0) AND (penalties_missed >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0) AND (saves >= 0) AND (bonus >= 0) AND (defensive_contribution >= 0) AND (dream_team_appearances >= 0) AND (return_count >= 0)`,
    ),
  ],
);

export const playerSeasonSummaryRefreshesInReporting = reporting.table(
  'player_season_summary_refreshes',
  {
    seasonId: smallint('season_id').notNull(),
    revision: bigint({ mode: 'number' }).notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true, mode: 'date' }).notNull(),
    playerCount: integer('player_count').notNull(),
    statsRowCount: bigint('stats_row_count', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_season_summary_refreshes_season_fk',
    }),
    primaryKey({
      columns: [table.seasonId],
      name: 'player_season_summary_refreshes_pkey',
    }),
    check('player_season_summary_refreshes_revision_positive', sql`revision > 0`),
    check(
      'player_season_summary_refreshes_counts_nonnegative',
      sql`(player_count >= 0) AND (stats_row_count >= 0)`,
    ),
  ],
);

/**
 * Materialized Player State projection.  The SQL migration owns the exact
 * refresh function and grants; these declarations keep the writer's schema
 * contract and generated query types in lockstep with that projection.
 */
export const playerStateSeasonRowsInReporting = reporting.table(
  'player_state_season_rows',
  {
    seasonId: smallint('season_id').notNull(),
    seasonCode: text('season_code').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    playerCode: integer('player_code').notNull(),
    elementId: integer('element_id').notNull(),
    elementType: integer('element_type').notNull(),
    fplMinutes: integer('fpl_minutes').default(0).notNull(),
    fplGameweeks: integer('fpl_gameweeks').default(0).notNull(),
    fplPointsPer90: numeric('fpl_points_per_90'),
    fplReturnRate: numeric('fpl_return_rate'),
    fplBonusPer90: numeric('fpl_bonus_per_90'),
    fplPositionPercentile: numeric('fpl_position_percentile'),
    fplPeerCount: integer('fpl_peer_count').default(0).notNull(),
    expectedMetricsAvailable: boolean('expected_metrics_available').notNull(),
    fplSourceHash: text('fpl_source_hash').notNull(),
    fplSourceUpdatedAt: timestamp('fpl_source_updated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    understatMappingStatus: text('understat_mapping_status').notNull(),
    understatPlayerId: integer('understat_player_id'),
    understatSeasonState: text('understat_season_state'),
    understatMinutes: integer('understat_minutes'),
    understatNpxgPer90: numeric('understat_npxg_per_90'),
    understatXaPer90: numeric('understat_xa_per_90'),
    understatShotsPer90: numeric('understat_shots_per_90'),
    understatKeyPassesPer90: numeric('understat_key_passes_per_90'),
    understatXgChainPer90: numeric('understat_xg_chain_per_90'),
    understatXgBuildupPer90: numeric('understat_xg_buildup_per_90'),
    understatNpxgPercentile: numeric('understat_npxg_percentile'),
    understatXaPercentile: numeric('understat_xa_percentile'),
    understatShotsPercentile: numeric('understat_shots_percentile'),
    understatKeyPassesPercentile: numeric('understat_key_passes_percentile'),
    understatXgChainPercentile: numeric('understat_xg_chain_percentile'),
    understatXgBuildupPercentile: numeric('understat_xg_buildup_percentile'),
    understatProcessPercentile: numeric('understat_process_percentile'),
    understatPeerCount: integer('understat_peer_count').default(0).notNull(),
    understatSourceHash: text('understat_source_hash'),
    understatSourceUpdatedAt: timestamp('understat_source_updated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    fplTotalPoints: integer('fpl_total_points').default(0).notNull(),
    fplStarts: integer('fpl_starts').default(0).notNull(),
    fplCleanSheets: integer('fpl_clean_sheets').default(0).notNull(),
    fplSaves: integer('fpl_saves').default(0).notNull(),
  },
  (table) => [
    index('player_state_season_rows_player_idx').using(
      'btree',
      table.playerCode.asc().nullsLast(),
      table.seasonId.desc().nullsLast(),
    ),
    index('player_state_season_rows_season_position_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementType.asc().nullsLast(),
      table.playerCode.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_state_season_rows_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_state_season_rows_player_fk',
    }),
    foreignKey({
      columns: [table.seasonCode, table.understatPlayerId],
      foreignColumns: [playerSeasonsInUnderstat.seasonCode, playerSeasonsInUnderstat.playerId],
      name: 'player_state_season_rows_understat_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.playerCode],
      name: 'player_state_season_rows_pkey',
    }),
    check(
      'player_state_season_rows_counts_nonnegative',
      sql`(fpl_minutes >= 0) AND (fpl_gameweeks >= 0) AND (fpl_peer_count >= 0) AND (understat_peer_count >= 0)`,
    ),
    check(
      'player_state_season_rows_fpl_summary_counts_nonnegative',
      sql`(fpl_starts >= 0) AND (fpl_clean_sheets >= 0) AND (fpl_saves >= 0)`,
    ),
    check(
      'player_state_season_rows_mapping_check',
      sql`understat_mapping_status = ANY (ARRAY['VERIFIED'::text, 'UNVERIFIED'::text, 'AMBIGUOUS'::text, 'QUARANTINED'::text, 'UNAVAILABLE'::text])`,
    ),
    check('player_state_season_rows_season_code_check', sql`season_code ~ '^[0-9]{4}$'::text`),
    check(
      'player_state_season_rows_lifecycle_check',
      sql`lifecycle_state = ANY (ARRAY['reference_only'::text, 'completed'::text, 'preseason'::text, 'active'::text, 'closed'::text])`,
    ),
    check('player_state_season_rows_fpl_hash_check', sql`btrim(fpl_source_hash) <> ''::text`),
    check(
      'player_state_season_rows_understat_counts_check',
      sql`(understat_minutes IS NULL) OR (understat_minutes >= 0)`,
    ),
    check(
      'player_state_season_rows_percentiles_check',
      sql`((fpl_position_percentile IS NULL) OR ((fpl_position_percentile >= 0) AND (fpl_position_percentile <= 100))) AND ((understat_process_percentile IS NULL) OR ((understat_process_percentile >= 0) AND (understat_process_percentile <= 100)))`,
    ),
  ],
);

export const playerStateSeasonRefreshesInReporting = reporting.table(
  'player_state_season_refreshes',
  {
    seasonId: smallint('season_id').notNull(),
    revision: bigint({ mode: 'number' }).notNull(),
    fplSourceUpdatedAt: timestamp('fpl_source_updated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    understatSourceUpdatedAt: timestamp('understat_source_updated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    bridgeSourceUpdatedAt: timestamp('bridge_source_updated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true, mode: 'date' }).notNull(),
    playerCount: integer('player_count').notNull(),
    understatPlayerCount: integer('understat_player_count').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_state_season_refreshes_season_fk',
    }),
    primaryKey({ columns: [table.seasonId], name: 'player_state_season_refreshes_pkey' }),
    check('player_state_season_refreshes_revision_positive', sql`revision > 0`),
    check(
      'player_state_season_refreshes_counts_nonnegative',
      sql`(player_count >= 0) AND (understat_player_count >= 0)`,
    ),
  ],
);

export const playerStateDatasetMetadataInReporting = reporting.table(
  'player_state_dataset_metadata',
  {
    datasetKey: text('dataset_key').primaryKey().notNull(),
    revision: bigint({ mode: 'number' }).notNull(),
    methodVersion: text('method_version').notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (_table) => [
    check('player_state_dataset_metadata_key_check', sql`dataset_key = 'player_state'`),
    check('player_state_dataset_metadata_revision_positive', sql`revision > 0`),
    check('player_state_dataset_metadata_method_check', sql`btrim(method_version) <> ''::text`),
  ],
);

export const playerSeasonSummariesInReporting = reporting
  .view('player_season_summaries', {
    seasonId: smallint('season_id'),
    elementId: integer('element_id'),
    elementType: integer('element_type'),
    gameweeksAvailable: integer('gameweeks_available'),
    gameweeksStarted: integer('gameweeks_started'),
    minutes: integer(),
    goalsScored: integer('goals_scored'),
    assists: integer(),
    cleanSheets: integer('clean_sheets'),
    goalsConceded: integer('goals_conceded'),
    ownGoals: integer('own_goals'),
    penaltiesSaved: integer('penalties_saved'),
    penaltiesMissed: integer('penalties_missed'),
    yellowCards: integer('yellow_cards'),
    redCards: integer('red_cards'),
    saves: integer(),
    bonus: integer(),
    bps: integer(),
    totalPoints: integer('total_points'),
    defensiveContribution: integer('defensive_contribution'),
    expectedGoals: numeric('expected_goals'),
    expectedAssists: numeric('expected_assists'),
    expectedGoalInvolvements: numeric('expected_goal_involvements'),
    expectedGoalsConceded: numeric('expected_goals_conceded'),
    dreamTeamAppearances: integer('dream_team_appearances'),
    returnCount: integer('return_count'),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true, mode: 'date' }),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true, mode: 'date' }),
  })
  .with({ securityInvoker: true })
  .as(
    sql`SELECT season_id, element_id, element_type, gameweeks_available, gameweeks_started, minutes, goals_scored, assists, clean_sheets, goals_conceded, own_goals, penalties_saved, penalties_missed, yellow_cards, red_cards, saves, bonus, bps, total_points, defensive_contribution, expected_goals, expected_assists, expected_goal_involvements, expected_goals_conceded, dream_team_appearances, return_count, source_updated_at, refreshed_at FROM reporting.player_season_summary_rows`,
  );

export const playerValueChangesInReporting = reporting
  .view('player_value_changes', {
    seasonId: smallint('season_id'),
    seasonCode: text('season_code'),
    snapshotDate: date('snapshot_date'),
    elementId: integer('element_id'),
    elementType: integer('element_type'),
    eventId: integer('event_id'),
    value: integer(),
    lastValue: integer('last_value'),
    changeType: text('change_type'),
    valueChange: integer('value_change'),
    snapshotSource: text('snapshot_source'),
    sourceValueId: integer('source_value_id'),
  })
  .with({ securityInvoker: true })
  .as(
    sql`SELECT snapshot.season_id, season.season_code, snapshot.snapshot_date, snapshot.element_id, snapshot.element_type, COALESCE(snapshot.source_event_id, event.event_id) AS event_id, snapshot.price AS value, CASE WHEN previous.price IS NULL THEN 0 ELSE previous.price END AS last_value, CASE WHEN previous.price IS NULL THEN 'start'::text WHEN snapshot.price > previous.price THEN 'rise'::text ELSE 'fall'::text END AS change_type, CASE WHEN previous.price IS NULL THEN snapshot.price ELSE snapshot.price - previous.price END AS value_change, snapshot.snapshot_source, snapshot.source_value_id FROM fpl.player_market_snapshots snapshot JOIN fpl.seasons season ON season.season_id = snapshot.season_id LEFT JOIN LATERAL ( SELECT prior.price FROM fpl.player_market_snapshots prior WHERE prior.season_id = snapshot.season_id AND prior.element_id = snapshot.element_id AND prior.snapshot_date < snapshot.snapshot_date ORDER BY prior.snapshot_date DESC LIMIT 1 ) previous ON true LEFT JOIN fpl.events event ON event.season_id = snapshot.season_id AND event.deadline_time::date = snapshot.snapshot_date WHERE previous.price IS NULL OR snapshot.price IS DISTINCT FROM previous.price`,
  );

export const tournamentEventResultsInReporting = reporting
  .view('tournament_event_results', {
    tournamentId: integer('tournament_id'),
    seasonId: smallint('season_id'),
    eventId: integer('event_id'),
    resultType: text('result_type'),
    sourceResultId: integer('source_result_id'),
    groupId: integer('group_id'),
    matchId: integer('match_id'),
    playAgainstId: integer('play_against_id'),
    entryId: integer('entry_id'),
    opponentEntryId: integer('opponent_entry_id'),
    eventPoints: integer('event_points'),
    eventCost: integer('event_cost'),
    eventNetPoints: integer('event_net_points'),
    eventRank: integer('event_rank'),
    matchPoints: integer('match_points'),
    goalsFor: integer('goals_for'),
    goalsAgainst: integer('goals_against'),
    isWinner: boolean('is_winner'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
  })
  .with({ securityInvoker: true })
  .as(
    sql`SELECT points.tournament_id, points.season_id, points.event_id, 'points_group'::text AS result_type, points.source_result_id, points.group_id, NULL::integer AS match_id, NULL::integer AS play_against_id, points.entry_id, NULL::integer AS opponent_entry_id, points.event_points, points.event_cost, points.event_net_points, points.event_rank, NULL::integer AS match_points, NULL::integer AS goals_for, NULL::integer AS goals_against, NULL::boolean AS is_winner, points.created_at, points.updated_at FROM competition.tournament_points_group_results points UNION ALL SELECT battle.tournament_id, battle.season_id, battle.event_id, 'battle_group'::text AS result_type, battle.source_result_id, battle.group_id, NULL::integer AS match_id, NULL::integer AS play_against_id, side.entry_id, side.opponent_entry_id, NULL::integer AS event_points, NULL::integer AS event_cost, side.net_points AS event_net_points, side.event_rank, side.match_points, NULL::integer AS goals_for, NULL::integer AS goals_against, CASE WHEN side.match_points IS NULL OR side.opponent_match_points IS NULL THEN NULL::boolean ELSE side.match_points > side.opponent_match_points END AS is_winner, battle.created_at, battle.updated_at FROM competition.tournament_battle_group_results battle CROSS JOIN LATERAL ( VALUES (battle.home_entry_id,battle.away_entry_id,battle.home_net_points,battle.home_rank,battle.home_match_points,battle.away_match_points), (battle.away_entry_id,battle.home_entry_id,battle.away_net_points,battle.away_rank,battle.away_match_points,battle.home_match_points)) side(entry_id, opponent_entry_id, net_points, event_rank, match_points, opponent_match_points) WHERE side.entry_id IS NOT NULL UNION ALL SELECT knockout.tournament_id, knockout.season_id, knockout.event_id, 'knockout'::text AS result_type, knockout.source_result_id, NULL::integer AS group_id, knockout.match_id, knockout.play_against_id, side.entry_id, side.opponent_entry_id, NULL::integer AS event_points, NULL::integer AS event_cost, side.net_points AS event_net_points, NULL::integer AS event_rank, NULL::integer AS match_points, side.goals_for, side.goals_against, CASE WHEN knockout.match_winner IS NULL OR side.entry_id IS NULL THEN NULL::boolean ELSE knockout.match_winner = side.entry_id END AS is_winner, knockout.created_at, knockout.updated_at FROM competition.tournament_knockout_results knockout CROSS JOIN LATERAL ( VALUES (knockout.home_entry_id,knockout.away_entry_id,knockout.home_net_points,knockout.home_goals_scored,knockout.home_goals_conceded), (knockout.away_entry_id,knockout.home_entry_id,knockout.away_net_points,knockout.away_goals_scored,knockout.away_goals_conceded)) side(entry_id, opponent_entry_id, net_points, goals_for, goals_against) WHERE side.entry_id IS NOT NULL`,
  );

export const tournamentSelectionStatsInReporting = reporting
  .materializedView('tournament_selection_stats', {
    tournamentId: integer('tournament_id'),
    seasonId: smallint('season_id'),
    eventId: integer('event_id'),
    elementId: integer('element_id'),
    totalEntries: integer('total_entries'),
    selectedCount: integer('selected_count'),
    captainCount: integer('captain_count'),
    viceCaptainCount: integer('vice_captain_count'),
    effectiveSelectionCount: integer('effective_selection_count'),
    transferInCount: integer('transfer_in_count'),
    transferOutCount: integer('transfer_out_count'),
    selectionPercentage: numeric('selection_percentage'),
    captainPercentage: numeric('captain_percentage'),
    viceCaptainPercentage: numeric('vice_captain_percentage'),
    effectiveOwnershipPercentage: numeric('effective_ownership_percentage'),
  })
  .as(
    sql`
      WITH candidate_events AS (
        SELECT DISTINCT
          roster.tournament_id,
          roster.season_id,
          pick.event_id
        FROM competition.tournament_entries roster
        JOIN competition.entry_event_picks pick
          ON pick.season_id = roster.season_id
         AND pick.entry_id = roster.entry_id
      ), eligible_entries AS (
        SELECT
          candidate.tournament_id,
          candidate.season_id,
          candidate.event_id,
          roster.entry_id,
          entry.transfers_synced_through_event_id
        FROM candidate_events candidate
        JOIN competition.tournament_entries roster
          ON roster.tournament_id = candidate.tournament_id
         AND roster.season_id = candidate.season_id
        JOIN competition.entries entry
          ON entry.season_id = roster.season_id
         AND entry.entry_id = roster.entry_id
        WHERE COALESCE(entry.started_event, 1) <= candidate.event_id
      ), expected_entries AS (
        SELECT
          eligible.tournament_id,
          eligible.season_id,
          eligible.event_id,
          count(*)::integer AS total_entries,
          count(*) FILTER (
            WHERE eligible.transfers_synced_through_event_id >= eligible.event_id
          )::integer AS transfer_checkpoint_entries
        FROM eligible_entries eligible
        GROUP BY eligible.tournament_id, eligible.season_id, eligible.event_id
      ), valid_entry_events AS (
        SELECT
          eligible.tournament_id,
          eligible.season_id,
          eligible.event_id,
          eligible.entry_id
        FROM eligible_entries eligible
        JOIN competition.entry_event_picks pick
          ON pick.season_id = eligible.season_id
         AND pick.entry_id = eligible.entry_id
         AND pick.event_id = eligible.event_id
        GROUP BY
          eligible.tournament_id,
          eligible.season_id,
          eligible.event_id,
          eligible.entry_id
        HAVING count(*) = 15
           AND min(pick.position) = 1
           AND max(pick.position) = 15
           AND count(*) FILTER (WHERE pick.is_captain) = 1
           AND count(*) FILTER (WHERE pick.is_vice_captain) = 1
      ), complete_scopes AS (
        SELECT
          expected.tournament_id,
          expected.season_id,
          expected.event_id,
          expected.total_entries,
          expected.transfer_checkpoint_entries
        FROM expected_entries expected
        LEFT JOIN valid_entry_events valid
          ON valid.tournament_id = expected.tournament_id
         AND valid.season_id = expected.season_id
         AND valid.event_id = expected.event_id
        GROUP BY
          expected.tournament_id,
          expected.season_id,
          expected.event_id,
          expected.total_entries,
          expected.transfer_checkpoint_entries
        HAVING expected.total_entries > 0
           AND expected.transfer_checkpoint_entries = expected.total_entries
           AND count(valid.entry_id) = expected.total_entries
      ), eligible_picks AS (
        SELECT
          scope.tournament_id,
          scope.season_id,
          scope.event_id,
          scope.total_entries,
          pick.entry_id,
          pick.element_id,
          pick.multiplier,
          pick.is_captain,
          pick.is_vice_captain
        FROM complete_scopes scope
        JOIN eligible_entries eligible
          ON eligible.tournament_id = scope.tournament_id
         AND eligible.season_id = scope.season_id
         AND eligible.event_id = scope.event_id
        JOIN competition.entry_event_picks pick
          ON pick.season_id = eligible.season_id
         AND pick.entry_id = eligible.entry_id
         AND pick.event_id = eligible.event_id
      ), pick_stats AS (
        SELECT
          pick.tournament_id,
          pick.season_id,
          pick.event_id,
          pick.total_entries,
          pick.element_id,
          count(*)::integer AS selected_count,
          count(*) FILTER (WHERE pick.is_captain)::integer AS captain_count,
          count(*) FILTER (WHERE pick.is_vice_captain)::integer AS vice_captain_count,
          sum(pick.multiplier)::integer AS effective_selection_count
        FROM eligible_picks pick
        GROUP BY
          pick.tournament_id,
          pick.season_id,
          pick.event_id,
          pick.total_entries,
          pick.element_id
      ), transfer_stats AS (
        SELECT
          scope.tournament_id,
          scope.season_id,
          scope.event_id,
          element.element_id,
          count(*) FILTER (WHERE element.direction = 'in')::integer AS transfer_in_count,
          count(*) FILTER (WHERE element.direction = 'out')::integer AS transfer_out_count
        FROM complete_scopes scope
        JOIN eligible_entries eligible
          ON eligible.tournament_id = scope.tournament_id
         AND eligible.season_id = scope.season_id
         AND eligible.event_id = scope.event_id
        JOIN competition.entry_event_transfers transfer
          ON transfer.season_id = eligible.season_id
         AND transfer.entry_id = eligible.entry_id
         AND transfer.event_id = eligible.event_id
        CROSS JOIN LATERAL (
          VALUES
            (transfer.element_in_id, 'in'::text),
            (transfer.element_out_id, 'out'::text)
        ) AS element(element_id, direction)
        WHERE element.element_id IS NOT NULL
        GROUP BY scope.tournament_id, scope.season_id, scope.event_id, element.element_id
      ), elements AS (
        SELECT tournament_id, season_id, event_id, element_id FROM pick_stats
        UNION
        SELECT tournament_id, season_id, event_id, element_id FROM transfer_stats
      )
      SELECT
        element.tournament_id,
        element.season_id,
        element.event_id,
        element.element_id,
        scope.total_entries,
        COALESCE(pick.selected_count, 0)::integer AS selected_count,
        COALESCE(pick.captain_count, 0)::integer AS captain_count,
        COALESCE(pick.vice_captain_count, 0)::integer AS vice_captain_count,
        COALESCE(pick.effective_selection_count, 0)::integer AS effective_selection_count,
        COALESCE(transfer.transfer_in_count, 0)::integer AS transfer_in_count,
        COALESCE(transfer.transfer_out_count, 0)::integer AS transfer_out_count,
        round(COALESCE(pick.selected_count, 0)::numeric * 100 / NULLIF(scope.total_entries, 0), 4)
          AS selection_percentage,
        round(COALESCE(pick.captain_count, 0)::numeric * 100 / NULLIF(scope.total_entries, 0), 4)
          AS captain_percentage,
        round(COALESCE(pick.vice_captain_count, 0)::numeric * 100 / NULLIF(scope.total_entries, 0), 4)
          AS vice_captain_percentage,
        round(COALESCE(pick.effective_selection_count, 0)::numeric * 100 / NULLIF(scope.total_entries, 0), 4)
          AS effective_ownership_percentage
      FROM elements element
      JOIN complete_scopes scope
        ON scope.tournament_id = element.tournament_id
       AND scope.season_id = element.season_id
       AND scope.event_id = element.event_id
      LEFT JOIN pick_stats pick
        ON pick.tournament_id = element.tournament_id
       AND pick.season_id = element.season_id
       AND pick.event_id = element.event_id
       AND pick.element_id = element.element_id
      LEFT JOIN transfer_stats transfer
        ON transfer.tournament_id = element.tournament_id
       AND transfer.season_id = element.season_id
       AND transfer.event_id = element.event_id
       AND transfer.element_id = element.element_id
    `,
  );

export const tournamentEntryEventSummariesInReporting = reporting
  .materializedView('tournament_entry_event_summaries', {
    tournamentId: integer('tournament_id'),
    seasonId: smallint('season_id'),
    eventId: integer('event_id'),
    entryId: integer('entry_id'),
    totalEntries: integer('total_entries'),
    eventPoints: integer('event_points'),
    eventTransfers: integer('event_transfers'),
    eventTransfersCost: integer('event_transfers_cost'),
    eventNetPoints: integer('event_net_points'),
    eventBenchPoints: integer('event_bench_points'),
    eventAutoSubPoints: integer('event_auto_sub_points'),
    eventRank: integer('event_rank'),
    eventChip: chipInCompetition('event_chip'),
    playedCaptainElementId: integer('played_captain_element_id'),
    captainPoints: integer('captain_points'),
    overallPoints: integer('overall_points'),
    overallRank: integer('overall_rank'),
    teamValue: integer('team_value'),
    bank: integer(),
    pickCount: integer('pick_count'),
    selectionPoints: integer('selection_points'),
    calculatedBenchPoints: integer('calculated_bench_points'),
    goalkeeperPoints: integer('goalkeeper_points'),
    defenderPoints: integer('defender_points'),
    midfielderPoints: integer('midfielder_points'),
    forwardPoints: integer('forward_points'),
    captainElementId: integer('captain_element_id'),
    viceCaptainElementId: integer('vice_captain_element_id'),
    transferRowCount: integer('transfer_row_count'),
    sourceFinalizedAt: timestamp('source_finalized_at', { withTimezone: true, mode: 'date' }),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    tournamentEventRank: bigint('tournament_event_rank', { mode: 'number' }),
    cumulativeNetPoints: integer('cumulative_net_points'),
    cumulativeTransfers: integer('cumulative_transfers'),
    cumulativeTransferCost: integer('cumulative_transfer_cost'),
    cumulativeBenchPoints: integer('cumulative_bench_points'),
    cumulativeAutoSubPoints: integer('cumulative_auto_sub_points'),
    cumulativeCaptainPoints: integer('cumulative_captain_points'),
  })
  .as(
    sql`
      WITH candidate_events AS (
        SELECT DISTINCT
          roster.tournament_id,
          roster.season_id,
          pick.event_id
        FROM competition.tournament_entries roster
        JOIN competition.entry_event_picks pick
          ON pick.season_id = roster.season_id
         AND pick.entry_id = roster.entry_id
      ), eligible_entries AS (
        SELECT
          candidate.tournament_id,
          candidate.season_id,
          candidate.event_id,
          roster.entry_id
        FROM candidate_events candidate
        JOIN competition.tournament_entries roster
          ON roster.tournament_id = candidate.tournament_id
         AND roster.season_id = candidate.season_id
        JOIN competition.entries entry
          ON entry.season_id = roster.season_id
         AND entry.entry_id = roster.entry_id
        WHERE COALESCE(entry.started_event, 1) <= candidate.event_id
      ), expected_entries AS (
        SELECT
          eligible.tournament_id,
          eligible.season_id,
          eligible.event_id,
          count(*)::integer AS total_entries
        FROM eligible_entries eligible
        GROUP BY eligible.tournament_id, eligible.season_id, eligible.event_id
      ), valid_entry_events AS (
        SELECT
          eligible.tournament_id,
          eligible.season_id,
          eligible.event_id,
          eligible.entry_id
        FROM eligible_entries eligible
        JOIN competition.entry_event_picks pick
          ON pick.season_id = eligible.season_id
         AND pick.entry_id = eligible.entry_id
         AND pick.event_id = eligible.event_id
        GROUP BY
          eligible.tournament_id,
          eligible.season_id,
          eligible.event_id,
          eligible.entry_id
        HAVING count(*) = 15
           AND min(pick.position) = 1
           AND max(pick.position) = 15
           AND count(*) FILTER (WHERE pick.is_captain) = 1
           AND count(*) FILTER (WHERE pick.is_vice_captain) = 1
      ), complete_scopes AS (
        SELECT
          expected.tournament_id,
          expected.season_id,
          expected.event_id,
          expected.total_entries
        FROM expected_entries expected
        LEFT JOIN valid_entry_events valid
          ON valid.tournament_id = expected.tournament_id
         AND valid.season_id = expected.season_id
         AND valid.event_id = expected.event_id
        GROUP BY
          expected.tournament_id,
          expected.season_id,
          expected.event_id,
          expected.total_entries
        HAVING expected.total_entries > 0
           AND count(valid.entry_id) = expected.total_entries
      ), pick_aggregates AS (
        SELECT
          eligible.tournament_id,
          pick.season_id,
          pick.event_id,
          pick.entry_id,
          count(*)::integer AS pick_count,
          sum(pick.multiplier * COALESCE(stats.total_points, 0))::integer AS selection_points,
          sum(
            CASE WHEN pick.multiplier = 0 THEN COALESCE(stats.total_points, 0) ELSE 0 END
          )::integer AS calculated_bench_points,
          sum(
            CASE
              WHEN player.element_type = 1
                THEN pick.multiplier * COALESCE(stats.total_points, 0)
              ELSE 0
            END
          )::integer AS goalkeeper_points,
          sum(
            CASE
              WHEN player.element_type = 2
                THEN pick.multiplier * COALESCE(stats.total_points, 0)
              ELSE 0
            END
          )::integer AS defender_points,
          sum(
            CASE
              WHEN player.element_type = 3
                THEN pick.multiplier * COALESCE(stats.total_points, 0)
              ELSE 0
            END
          )::integer AS midfielder_points,
          sum(
            CASE
              WHEN player.element_type = 4
                THEN pick.multiplier * COALESCE(stats.total_points, 0)
              ELSE 0
            END
          )::integer AS forward_points,
          max(pick.element_id) FILTER (WHERE pick.is_captain) AS captain_element_id,
          max(pick.element_id) FILTER (WHERE pick.is_vice_captain) AS vice_captain_element_id
        FROM eligible_entries eligible
        JOIN competition.entry_event_picks pick
          ON pick.season_id = eligible.season_id
         AND pick.entry_id = eligible.entry_id
         AND pick.event_id = eligible.event_id
        JOIN fpl.players player
          ON player.season_id = pick.season_id
         AND player.element_id = pick.element_id
        LEFT JOIN fpl.player_gameweek_stats stats
          ON stats.season_id = pick.season_id
         AND stats.event_id = pick.event_id
         AND stats.element_id = pick.element_id
        GROUP BY eligible.tournament_id, pick.season_id, pick.event_id, pick.entry_id
      ), transfer_aggregates AS (
        SELECT
          eligible.tournament_id,
          transfer.season_id,
          transfer.event_id,
          transfer.entry_id,
          count(*)::integer AS transfer_count
        FROM eligible_entries eligible
        JOIN competition.entry_event_transfers transfer
          ON transfer.season_id = eligible.season_id
         AND transfer.entry_id = eligible.entry_id
         AND transfer.event_id = eligible.event_id
        GROUP BY
          eligible.tournament_id,
          transfer.season_id,
          transfer.event_id,
          transfer.entry_id
      ), base AS (
        SELECT
          eligible.tournament_id,
          result.season_id,
          result.event_id,
          result.entry_id,
          scope.total_entries,
          result.event_points,
          result.event_transfers,
          result.event_transfers_cost,
          result.event_net_points,
          result.event_bench_points,
          result.event_auto_sub_points,
          result.event_rank,
          result.event_chip,
          result.played_captain_element_id,
          result.captain_points,
          result.overall_points,
          result.overall_rank,
          result.team_value,
          result.bank,
          pick.pick_count,
          pick.selection_points,
          pick.calculated_bench_points,
          pick.goalkeeper_points,
          pick.defender_points,
          pick.midfielder_points,
          pick.forward_points,
          pick.captain_element_id,
          pick.vice_captain_element_id,
          COALESCE(transfer.transfer_count, 0) AS transfer_row_count,
          event.live_snapshot_finalized_at AS source_finalized_at
        FROM complete_scopes scope
        JOIN eligible_entries eligible
          ON eligible.tournament_id = scope.tournament_id
         AND eligible.season_id = scope.season_id
         AND eligible.event_id = scope.event_id
        JOIN competition.entry_event_results result
          ON result.season_id = eligible.season_id
         AND result.entry_id = eligible.entry_id
         AND result.event_id = eligible.event_id
         AND result.rich_synced_at IS NOT NULL
        JOIN fpl.events event
          ON event.season_id = result.season_id
         AND event.event_id = result.event_id
         AND event.finished
         AND event.data_checked
         AND event.live_snapshot_finalized_at IS NOT NULL
        JOIN pick_aggregates pick
          ON pick.tournament_id = eligible.tournament_id
         AND pick.season_id = result.season_id
         AND pick.event_id = result.event_id
         AND pick.entry_id = result.entry_id
        LEFT JOIN transfer_aggregates transfer
          ON transfer.tournament_id = eligible.tournament_id
         AND transfer.season_id = result.season_id
         AND transfer.event_id = result.event_id
         AND transfer.entry_id = result.entry_id
      )
      SELECT
        base.tournament_id,
        base.season_id,
        base.event_id,
        base.entry_id,
        base.total_entries,
        base.event_points,
        base.event_transfers,
        base.event_transfers_cost,
        base.event_net_points,
        base.event_bench_points,
        base.event_auto_sub_points,
        base.event_rank,
        base.event_chip,
        base.played_captain_element_id,
        base.captain_points,
        base.overall_points,
        base.overall_rank,
        base.team_value,
        base.bank,
        base.pick_count,
        base.selection_points,
        base.calculated_bench_points,
        base.goalkeeper_points,
        base.defender_points,
        base.midfielder_points,
        base.forward_points,
        base.captain_element_id,
        base.vice_captain_element_id,
        base.transfer_row_count,
        base.source_finalized_at,
        rank() OVER (
          PARTITION BY base.tournament_id, base.event_id
          ORDER BY base.event_net_points DESC, base.entry_id
        ) AS tournament_event_rank,
        sum(base.event_net_points) OVER (
          PARTITION BY base.tournament_id, base.entry_id
          ORDER BY base.event_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )::integer AS cumulative_net_points,
        sum(base.event_transfers) OVER (
          PARTITION BY base.tournament_id, base.entry_id
          ORDER BY base.event_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )::integer AS cumulative_transfers,
        sum(base.event_transfers_cost) OVER (
          PARTITION BY base.tournament_id, base.entry_id
          ORDER BY base.event_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )::integer AS cumulative_transfer_cost,
        sum(COALESCE(base.event_bench_points, 0)) OVER (
          PARTITION BY base.tournament_id, base.entry_id
          ORDER BY base.event_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )::integer AS cumulative_bench_points,
        sum(COALESCE(base.event_auto_sub_points, 0)) OVER (
          PARTITION BY base.tournament_id, base.entry_id
          ORDER BY base.event_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )::integer AS cumulative_auto_sub_points,
        sum(COALESCE(base.captain_points, 0)) OVER (
          PARTITION BY base.tournament_id, base.entry_id
          ORDER BY base.event_id
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )::integer AS cumulative_captain_points
      FROM base
    `,
  );

export const myFplActiveSnapshotStatusInReporting = reporting
  .view('my_fpl_active_snapshot_status', {
    seasonId: smallint('season_id'),
    eventId: integer('event_id'),
    revision: bigint('revision', { mode: 'number' }),
    snapshotDate: date('snapshot_date'),
    kind: text('kind'),
    finished: boolean('finished'),
    dataChecked: boolean('data_checked'),
    dataCheckedAt: timestamp('data_checked_at', { withTimezone: true, mode: 'date' }),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    finalizationStartedAt: timestamp('finalization_started_at', {
      withTimezone: true,
      mode: 'date',
    }),
    finalizationDueAt: timestamp('finalization_due_at', { withTimezone: true, mode: 'date' }),
    expectedEntryCount: integer('expected_entry_count'),
    observedEntryCount: integer('observed_entry_count'),
    notApplicableEntryCount: integer('not_applicable_entry_count'),
    expectedNotApplicableEntryCount: integer('expected_not_applicable_entry_count'),
    pendingCorrectionEntryCount: integer('pending_correction_entry_count'),
    expectedTournamentCount: integer('expected_tournament_count'),
    observedTournamentCount: integer('observed_tournament_count'),
    coverageState: text('coverage_state'),
    expectedEntryScopeSha256: text('expected_entry_scope_sha256'),
    expectedTournamentScopeSha256: text('expected_tournament_scope_sha256'),
    observedEntryScopeSha256: text('observed_entry_scope_sha256'),
    observedTournamentScopeSha256: text('observed_tournament_scope_sha256'),
  })
  .with({ securityInvoker: true })
  .as(
    sql`WITH active AS (
  SELECT publication.season_id,
         publication.event_id,
         publication.revision,
         publication.snapshot_date,
         publication.kind,
         publication.source_checked_at,
         publication.published_at,
         publication.expected_entry_count,
         publication.ready_entry_count,
         publication.empty_entry_count,
         publication.not_applicable_entry_count,
         publication.expected_tournament_count,
         publication.ready_tournament_count,
         publication.entry_scope_sha256,
         publication.tournament_scope_sha256
  FROM competition.my_fpl_snapshot_publications publication
  WHERE publication.active
), shaped AS (
  SELECT event.season_id,
         event.event_id,
         event.finished,
         event.data_checked,
         event.data_checked_at,
         active.revision,
         active.snapshot_date,
         active.kind,
         active.source_checked_at,
         active.published_at,
         active.expected_entry_count,
         active.ready_entry_count,
         active.empty_entry_count,
         active.not_applicable_entry_count,
         active.expected_tournament_count,
         active.ready_tournament_count,
         active.entry_scope_sha256,
         active.tournament_scope_sha256,
         state.entry_scope_generation = state.verified_entry_scope_generation
           AND state.tournament_scope_generation = state.verified_tournament_scope_generation
           AND state.verified_revision = active.revision
           AND event.finished
           AND event.data_checked
           AND active.kind = 'FINAL'
           AND active.entry_scope_sha256 IS NOT NULL
           AND active.tournament_scope_sha256 IS NOT NULL AS final_verified
  FROM fpl.events event
  LEFT JOIN active
    ON active.season_id = event.season_id AND active.event_id = event.event_id
  LEFT JOIN competition.my_fpl_snapshot_scope_state state
    ON state.season_id = event.season_id AND state.event_id = event.event_id
)
SELECT shaped.season_id,
       shaped.event_id,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.revision END AS revision,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.snapshot_date END AS snapshot_date,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.kind END AS kind,
       shaped.finished,
       shaped.data_checked,
       shaped.data_checked_at,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.source_checked_at END AS source_checked_at,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.published_at END AS published_at,
       CASE WHEN shaped.data_checked_at IS NULL THEN NULL ELSE shaped.data_checked_at END
         AS finalization_started_at,
       CASE WHEN shaped.data_checked_at IS NULL THEN NULL
            ELSE shaped.data_checked_at + interval '4500 seconds' END
         AS finalization_due_at,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.expected_entry_count END AS expected_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.ready_entry_count + shaped.empty_entry_count END
         AS observed_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.not_applicable_entry_count END AS not_applicable_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.not_applicable_entry_count END AS expected_not_applicable_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN GREATEST(shaped.expected_entry_count - shaped.ready_entry_count - shaped.empty_entry_count, 0)
         END AS pending_correction_entry_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.expected_tournament_count END AS expected_tournament_count,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.ready_tournament_count END AS observed_tournament_count,
       CASE
         WHEN shaped.kind IS NULL THEN 'NO_PUBLICATION'
         WHEN shaped.final_verified THEN 'COMPLETE'
         WHEN shaped.kind = 'PROVISIONAL'
          AND shaped.ready_entry_count + shaped.empty_entry_count = shaped.expected_entry_count
          AND shaped.ready_tournament_count = shaped.expected_tournament_count
           THEN 'COMPLETE'
         ELSE 'CORRECTION_PENDING'
       END AS coverage_state,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.entry_scope_sha256 END AS expected_entry_scope_sha256,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.tournament_scope_sha256 END AS expected_tournament_scope_sha256,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.entry_scope_sha256 END AS observed_entry_scope_sha256,
       CASE WHEN shaped.final_verified OR shaped.kind = 'PROVISIONAL'
            THEN shaped.tournament_scope_sha256 END AS observed_tournament_scope_sha256
FROM shaped`,
  );
