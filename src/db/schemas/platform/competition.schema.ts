// Canonical competition PostgreSQL schema declarations.
import {
  foreignKey,
  unique,
  check,
  smallint,
  text,
  jsonb,
  timestamp,
  index,
  uuid,
  integer,
  boolean,
  uniqueIndex,
  bigint,
  date,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  chipInCompetition,
  competition,
  cupResultInCompetition,
  groupModeInCompetition,
  knockoutModeInCompetition,
  leagueTypeInCompetition,
  officialLeagueKindInCompetition,
  tournamentModeInCompetition,
  tournamentRosterModeInCompetition,
  tournamentSetupPhaseInCompetition,
  tournamentSetupStatusInCompetition,
  tournamentStateInCompetition,
} from './namespaces.schema';
import { seasonsInFpl, playersInFpl, teamsInFpl, eventsInFpl } from './fpl.schema';

export const myFplSnapshotPublicationRevisionsInCompetition = competition.sequence(
  'my_fpl_snapshot_revision_seq',
  {
    startWith: '1',
    increment: '1',
    minValue: '1',
    maxValue: '9223372036854775807',
    cache: '1',
    cycle: false,
  },
);

export const tournamentsInCompetition = competition.table(
  'tournaments',
  {
    tournamentId: integer('tournament_id').primaryKey().generatedByDefaultAsIdentity({
      name: 'tournaments_tournament_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    seasonId: smallint('season_id').notNull(),
    name: text().notNull(),
    creator: text().notNull(),
    adminEntryId: integer('admin_entry_id').notNull(),
    leagueId: integer('league_id').notNull(),
    leagueType: leagueTypeInCompetition('league_type').notNull(),
    totalTeamNum: integer('total_team_num').notNull(),
    tournamentMode: tournamentModeInCompetition('tournament_mode').notNull(),
    groupMode: groupModeInCompetition('group_mode'),
    groupTeamNum: integer('group_team_num'),
    groupNum: integer('group_num'),
    groupStartedEventId: integer('group_started_event_id'),
    groupEndedEventId: integer('group_ended_event_id'),
    groupAutoAverages: boolean('group_auto_averages').notNull(),
    groupRounds: integer('group_rounds'),
    groupPlayAgainstNum: integer('group_play_against_num'),
    groupQualifyNum: integer('group_qualify_num'),
    knockoutMode: knockoutModeInCompetition('knockout_mode'),
    knockoutTeamNum: integer('knockout_team_num'),
    knockoutRounds: integer('knockout_rounds'),
    knockoutEventNum: integer('knockout_event_num'),
    knockoutStartedEventId: integer('knockout_started_event_id'),
    knockoutEndedEventId: integer('knockout_ended_event_id'),
    knockoutPlayAgainstNum: integer('knockout_play_against_num'),
    state: tournamentStateInCompetition().notNull(),
    setupStatus: tournamentSetupStatusInCompetition('setup_status').default('pending').notNull(),
    setupError: text('setup_error'),
    setupStartedAt: timestamp('setup_started_at', { withTimezone: true, mode: 'date' }),
    setupFinishedAt: timestamp('setup_finished_at', { withTimezone: true, mode: 'date' }),
    sourceLeagueName: text('source_league_name'),
    rosterMode: tournamentRosterModeInCompetition('roster_mode').default('snapshot').notNull(),
    rosterSyncStatus: tournamentSetupStatusInCompetition('roster_sync_status'),
    rosterLastSyncedAt: timestamp('roster_last_synced_at', { withTimezone: true, mode: 'date' }),
    rosterSyncError: text('roster_sync_error'),
    setupPhase: tournamentSetupPhaseInCompetition('setup_phase').default('queued').notNull(),
    setupCompletedUnits: integer('setup_completed_units').default(0).notNull(),
    setupTotalUnits: integer('setup_total_units').default(0).notNull(),
    setupProgressUpdatedAt: timestamp('setup_progress_updated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    standingsReadyAt: timestamp('standings_ready_at', { withTimezone: true, mode: 'date' }),
    setupWarningCount: integer('setup_warning_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    officialScheduleHash: text('official_schedule_hash'),
    officialScheduleSyncedAt: timestamp('official_schedule_synced_at', {
      withTimezone: true,
      mode: 'date',
    }),
    officialScheduleLockedAt: timestamp('official_schedule_locked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    // Preview-backed creates persist the idempotency fingerprint on the
    // authoritative row so recovery cannot infer ownership from name/time.
    previewPayloadFingerprint: text('preview_payload_fingerprint'),
    setupAttempt: integer('setup_attempt').default(0).notNull(),
    setupMaxAttempts: integer('setup_max_attempts').default(3).notNull(),
    setupNextRetryAt: timestamp('setup_next_retry_at', { withTimezone: true, mode: 'date' }),
    setupLastErrorCode: text('setup_last_error_code'),
    setupLastErrorAt: timestamp('setup_last_error_at', { withTimezone: true, mode: 'date' }),
    setupProgressIndeterminate: boolean('setup_progress_indeterminate').default(false).notNull(),
    profilesReadyAt: timestamp('profiles_ready_at', { withTimezone: true, mode: 'date' }),
    insightsReadyAt: timestamp('insights_ready_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('tournaments_admin_entry_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.adminEntryId.asc().nullsLast(),
    ),
    index('tournaments_group_end_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.groupEndedEventId.asc().nullsLast(),
    ),
    index('tournaments_group_start_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.groupStartedEventId.asc().nullsLast(),
    ),
    index('tournaments_knockout_end_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.knockoutEndedEventId.asc().nullsLast(),
    ),
    index('tournaments_knockout_start_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.knockoutStartedEventId.asc().nullsLast(),
    ),
    index('tournaments_league_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.leagueId.asc().nullsLast(),
      table.leagueType.asc().nullsLast(),
    ),
    index('tournaments_state_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.state.asc().nullsLast(),
      table.setupStatus.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'tournaments_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.adminEntryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournaments_admin_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.groupEndedEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournaments_group_end_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.groupStartedEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournaments_group_start_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.knockoutEndedEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournaments_knockout_end_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.knockoutStartedEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournaments_knockout_start_event_fk',
    }),
    unique('tournaments_season_identity_unique').on(table.seasonId, table.tournamentId),
    unique('tournaments_name_key').on(table.seasonId, table.name),
    check(
      'tournaments_ids_positive',
      sql`(tournament_id > 0) AND (admin_entry_id > 0) AND (league_id > 0) AND (total_team_num > 0)`,
    ),
    check(
      'tournaments_name_nonempty',
      sql`(btrim(name) <> ''::text) AND (btrim(creator) <> ''::text)`,
    ),
    check(
      'tournaments_setup_counts_valid',
      sql`(setup_completed_units >= 0) AND (setup_total_units >= 0) AND (setup_completed_units <= setup_total_units) AND (setup_warning_count >= 0)`,
    ),
    check(
      'tournaments_setup_attempts_valid',
      sql`setup_attempt >= 0 AND setup_max_attempts >= 1 AND setup_attempt <= setup_max_attempts`,
    ),
    check(
      'tournaments_group_event_order',
      sql`(group_ended_event_id IS NULL) OR (group_started_event_id IS NULL) OR (group_ended_event_id >= group_started_event_id)`,
    ),
    check(
      'tournaments_knockout_event_order',
      sql`(knockout_ended_event_id IS NULL) OR (knockout_started_event_id IS NULL) OR (knockout_ended_event_id >= knockout_started_event_id)`,
    ),
    check(
      'tournaments_setup_time_order',
      sql`(setup_finished_at IS NULL) OR (setup_started_at IS NULL) OR (setup_finished_at >= setup_started_at)`,
    ),
  ],
);

export const tournamentOfficialH2HPageManifestsInCompetition = competition.table(
  'tournament_official_h2h_page_manifests',
  {
    seasonId: smallint('season_id').notNull(),
    tournamentId: integer('tournament_id').notNull(),
    pageNumber: integer('page_number').notNull(),
    scheduleHash: text('schedule_hash').notNull(),
    matchIds: integer('match_ids').array().notNull(),
    eventIds: integer('event_ids').array().notNull(),
    immutablePageHash: text('immutable_page_hash').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.tournamentId, table.pageNumber],
      name: 'tournament_official_h2h_page_manifests_pkey',
    }),
    index('tournament_h2h_manifest_event_idx')
      .on(table.seasonId, table.tournamentId)
      .where(sql`locked_at IS NOT NULL`),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'tournament_h2h_manifest_tournament_fk',
    }).onDelete('cascade'),
    check('tournament_h2h_manifest_page_positive', sql`page_number > 0`),
    check('tournament_h2h_manifest_schedule_hash', sql`schedule_hash ~ '^[0-9a-f]{64}$'`),
    check('tournament_h2h_manifest_immutable_hash', sql`immutable_page_hash ~ '^[0-9a-f]{64}$'`),
    check('tournament_h2h_manifest_match_ids_nonempty', sql`cardinality(match_ids) > 0`),
    check('tournament_h2h_manifest_event_ids_nonempty', sql`cardinality(event_ids) > 0`),
    check(
      'tournament_h2h_manifest_match_ids_positive',
      sql`array_position(match_ids, NULL) IS NULL AND array_to_string(match_ids, ',') ~ '^[1-9][0-9]*(,[1-9][0-9]*)*$'`,
    ),
    check(
      'tournament_h2h_manifest_event_ids_positive',
      sql`array_position(event_ids, NULL) IS NULL AND array_to_string(event_ids, ',') ~ '^[1-9][0-9]*(,[1-9][0-9]*)*$'`,
    ),
    check(
      'tournament_h2h_manifest_arrays_1d',
      sql`array_ndims(match_ids) = 1 AND array_ndims(event_ids) = 1`,
    ),
  ],
);

export const tournamentSetupIssuesInCompetition = competition.table(
  'tournament_setup_issues',
  {
    issueId: bigint('issue_id', { mode: 'number' })
      .generatedByDefaultAsIdentity({ name: 'tournament_setup_issues_issue_id_seq' })
      .primaryKey(),
    seasonId: smallint('season_id').notNull(),
    tournamentId: integer('tournament_id').notNull(),
    issueKey: text('issue_key').notNull(),
    code: text().notNull(),
    category: text().notNull(),
    severity: text().notNull(),
    eventId: integer('event_id'),
    affectedEntryIds: integer('affected_entry_ids')
      .array()
      .default(sql`'{}'::integer[]`)
      .notNull(),
    affectedEntryCount: integer('affected_entry_count').default(0).notNull(),
    diagnosticCode: text('diagnostic_code'),
    internalMessage: text('internal_message'),
    repairAttempts: integer('repair_attempts').default(0).notNull(),
    nextRepairAt: timestamp('next_repair_at', { withTimezone: true, mode: 'date' }),
    repairExhaustedAt: timestamp('repair_exhausted_at', { withTimezone: true, mode: 'date' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'tournament_setup_issues_tournament_fk',
    }).onDelete('cascade'),
    unique('tournament_setup_issues_scope_unique').on(
      table.seasonId,
      table.tournamentId,
      table.issueKey,
    ),
    index('tournament_setup_issues_unresolved_idx')
      .using(
        'btree',
        table.seasonId.asc().nullsLast(),
        table.tournamentId.asc().nullsLast(),
        table.category.asc().nullsLast(),
        table.severity.asc().nullsLast(),
      )
      .where(sql`resolved_at IS NULL`),
    index('tournament_setup_issues_repair_due_idx')
      .using(
        'btree',
        table.nextRepairAt.asc().nullsLast(),
        table.seasonId.asc().nullsLast(),
        table.tournamentId.asc().nullsLast(),
      )
      .where(
        sql`resolved_at IS NULL AND repair_exhausted_at IS NULL AND next_repair_at IS NOT NULL`,
      ),
    index('tournament_setup_issues_event_idx')
      .using(
        'btree',
        table.seasonId.asc().nullsLast(),
        table.tournamentId.asc().nullsLast(),
        table.eventId.asc().nullsLast(),
      )
      .where(sql`resolved_at IS NULL AND event_id IS NOT NULL`),
    check(
      'tournament_setup_issues_category_valid',
      sql`category = ANY (ARRAY['profiles'::text, 'insights'::text, 'results'::text])`,
    ),
    check(
      'tournament_setup_issues_code_valid',
      sql`code = ANY (ARRAY['ENTRY_PROFILE_INCOMPLETE'::text, 'ENTRY_HISTORY_INCOMPLETE'::text, 'LEAGUE_INSIGHTS_INCOMPLETE'::text, 'SELECTION_INSIGHTS_INCOMPLETE'::text, 'TOURNAMENT_RESULTS_INCOMPLETE'::text, 'STRUCTURE_INTEGRITY_FAILED'::text])`,
    ),
    check(
      'tournament_setup_issues_severity_valid',
      sql`severity = ANY (ARRAY['warning'::text, 'blocking'::text])`,
    ),
    check(
      'tournament_setup_issues_key_nonempty',
      sql`btrim(issue_key) <> '' AND btrim(code) <> ''`,
    ),
    check(
      'tournament_setup_issues_counts_valid',
      sql`affected_entry_count >= 0 AND repair_attempts >= 0 AND affected_entry_count = cardinality(affected_entry_ids)`,
    ),
  ],
);

export const publicLeagueTrendsInCompetition = competition.table(
  'public_league_trends',
  {
    seasonId: smallint('season_id').notNull(),
    tournamentId: integer('tournament_id').notNull(),
    displayName: text('display_name').notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    enabled: boolean().default(false).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('public_league_trends_listing_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.enabled.asc().nullsLast(),
      table.sortOrder.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'public_league_trends_tournament_fk',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.seasonId, table.tournamentId],
      name: 'public_league_trends_pkey',
    }),
    check('public_league_trends_tournament_id_positive', sql`tournament_id > 0`),
    check('public_league_trends_display_name_nonempty', sql`btrim(display_name) <> ''::text`),
    check('public_league_trends_sort_order_nonnegative', sql`sort_order >= 0`),
  ],
);

export const tournamentEntriesInCompetition = competition.table(
  'tournament_entries',
  {
    tournamentId: integer('tournament_id').notNull(),
    seasonId: smallint('season_id').notNull(),
    leagueId: integer('league_id').notNull(),
    entryId: integer('entry_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('tournament_entries_season_entry_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.entryId.asc().nullsLast(),
    ),
    index('tournament_entries_tournament_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'tournament_entries_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_entries_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'tournament_entries_tournament_fk',
    }),
    primaryKey({ columns: [table.tournamentId, table.entryId], name: 'tournament_entries_pkey' }),
    check(
      'tournament_entries_ids_positive',
      sql`(tournament_id > 0) AND (league_id > 0) AND (entry_id > 0)`,
    ),
  ],
);

export const entrySeasonHistoriesInCompetition = competition.table(
  'entry_season_histories',
  {
    seasonId: smallint('season_id').notNull(),
    entryId: integer('entry_id').notNull(),
    sourceHistoryId: integer('source_history_id')
      .generatedByDefaultAsIdentity({
        name: 'entry_season_histories_source_history_id_seq',
      })
      .notNull(),
    sourceSeasonLabel: text('source_season_label').notNull(),
    totalPoints: integer('total_points').default(0).notNull(),
    overallRank: integer('overall_rank').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('entry_season_histories_entry_idx').using(
      'btree',
      table.entryId.asc().nullsLast(),
      table.seasonId.desc().nullsFirst(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'entry_season_histories_season_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.entryId], name: 'entry_season_histories_pkey' }),
    unique('entry_season_histories_source_id_unique').on(table.sourceHistoryId),
    check('entry_season_histories_ids_positive', sql`(entry_id > 0) AND (source_history_id > 0)`),
    check(
      'entry_season_histories_totals_nonnegative',
      sql`(total_points >= 0) AND (overall_rank >= 0)`,
    ),
    check(
      'entry_season_histories_label_format',
      sql`source_season_label ~ '^[0-9]{4}/[0-9]{2}$'::text`,
    ),
  ],
);

export const entryLeaguesInCompetition = competition.table(
  'entry_leagues',
  {
    seasonId: smallint('season_id').notNull(),
    entryId: integer('entry_id').notNull(),
    leagueId: integer('league_id').notNull(),
    leagueType: leagueTypeInCompetition('league_type').notNull(),
    sourceEntryLeagueId: integer('source_entry_league_id')
      .generatedByDefaultAsIdentity({
        name: 'entry_leagues_source_entry_league_id_seq',
      })
      .notNull(),
    leagueName: text('league_name').notNull(),
    startedEvent: integer('started_event'),
    entryRank: integer('entry_rank'),
    entryLastRank: integer('entry_last_rank'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    officialKind: officialLeagueKindInCompetition('official_kind'),
    shortName: text('short_name'),
  },
  (table) => [
    index('entry_leagues_league_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.leagueId.asc().nullsLast(),
      table.leagueType.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'entry_leagues_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'entry_leagues_entry_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.entryId, table.leagueId, table.leagueType],
      name: 'entry_leagues_pkey',
    }),
    unique('entry_leagues_source_id_unique').on(table.sourceEntryLeagueId),
    check(
      'entry_leagues_ids_positive',
      sql`(entry_id > 0) AND (league_id > 0) AND (source_entry_league_id > 0)`,
    ),
    check('entry_leagues_name_nonempty', sql`btrim(league_name) <> ''::text`),
    check(
      'entry_leagues_short_name_nonempty',
      sql`(short_name IS NULL) OR (btrim(short_name) <> ''::text)`,
    ),
    check(
      'entry_leagues_official_kind_supported',
      sql`(official_kind IS NULL) OR (official_kind <> 'c'::competition.official_league_kind)`,
    ),
    check(
      'entry_leagues_started_event_positive',
      sql`(started_event IS NULL) OR (started_event > 0)`,
    ),
  ],
);

export const entryEventPicksInCompetition = competition.table(
  'entry_event_picks',
  {
    seasonId: smallint('season_id').notNull(),
    entryId: integer('entry_id').notNull(),
    eventId: integer('event_id').notNull(),
    position: smallint().notNull(),
    elementId: integer('element_id').notNull(),
    multiplier: smallint().notNull(),
    isCaptain: boolean('is_captain').notNull(),
    isViceCaptain: boolean('is_vice_captain').notNull(),
    activeChip: chipInCompetition('active_chip'),
    transfers: integer(),
    transfersCost: integer('transfers_cost'),
    sourcePickRowId: integer('source_pick_row_id')
      .generatedByDefaultAsIdentity({
        name: 'entry_event_picks_source_pick_row_id_seq',
      })
      .notNull(),
    sourceCreatedAt: timestamp('source_created_at', { withTimezone: true, mode: 'date' }).notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Team captured with the event pick; never derive scoring identity from mutable players.team_id. */
    eventTeamId: integer('event_team_id'),
  },
  (table) => [
    index('entry_event_picks_element_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    index('entry_event_picks_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
      table.entryId.asc().nullsLast(),
    ),
    index('entry_event_picks_player_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
    ),
    index('entry_event_picks_event_team_idx').on(table.seasonId, table.eventId, table.eventTeamId),
    index('entry_event_picks_source_row_idx').using(
      'btree',
      table.sourcePickRowId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'entry_event_picks_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'entry_event_picks_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'entry_event_picks_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'entry_event_picks_player_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventTeamId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'entry_event_picks_event_team_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.entryId, table.eventId, table.position],
      name: 'entry_event_picks_pkey',
    }),
    unique('entry_event_picks_element_once').on(
      table.seasonId,
      table.entryId,
      table.eventId,
      table.elementId,
    ),
    check(
      'entry_event_picks_ids_positive',
      sql`(entry_id > 0) AND (event_id > 0) AND (element_id > 0) AND (source_pick_row_id > 0)`,
    ),
    check('entry_event_picks_position_valid', sql`("position" >= 1) AND ("position" <= 15)`),
    check('entry_event_picks_multiplier_valid', sql`(multiplier >= 0) AND (multiplier <= 3)`),
    check('entry_event_picks_captain_roles_distinct', sql`NOT (is_captain AND is_vice_captain)`),
    check(
      'entry_event_picks_event_metadata_once',
      sql`("position" = 1) OR ((active_chip IS NULL) AND (transfers IS NULL) AND (transfers_cost IS NULL))`,
    ),
    check(
      'entry_event_picks_transfer_counts_nonnegative',
      sql`((transfers IS NULL) OR (transfers >= 0)) AND ((transfers_cost IS NULL) OR (transfers_cost >= 0))`,
    ),
    check('entry_event_picks_source_time_order', sql`source_updated_at >= source_created_at`),
  ],
);

/**
 * V2 completeness head for one immutable entry/event input.  The row is a
 * checkpoint index, not the source of truth for individual picks: a head is
 * valid only when it points at a 15-row set in entry_event_picks.
 */
export const entryEventPickHeadsInCompetition = competition.table(
  'entry_event_pick_heads',
  {
    seasonId: smallint('season_id').notNull(),
    entryId: integer('entry_id').notNull(),
    eventId: integer('event_id').notNull(),
    publicationId: text('publication_id').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    picksBaseRevision: text('picks_base_revision').notNull(),
    contentSha256: text('content_sha256').notNull(),
    rowCount: smallint('row_count').notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    contentUpdatedAt: timestamp('content_updated_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    checkpointedAt: timestamp('checkpointed_at', { withTimezone: true, mode: 'date' }).notNull(),
    state: text().notNull().default('COMPLETE'),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.entryId, table.eventId],
      name: 'entry_event_pick_heads_pkey',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'entry_event_pick_heads_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'entry_event_pick_heads_event_fk',
    }),
    // PostgreSQL migration 0067 owns this covering index because Drizzle
    // 0.43 cannot express INCLUDE columns in a declaration export.
    check(
      'entry_event_pick_heads_identity_valid',
      sql`entry_id > 0 AND event_id > 0 AND generation > 0 AND row_count = 15 AND state = 'COMPLETE' AND picks_base_revision ~ '^[0-9a-f]{64}$' AND content_sha256 ~ '^[0-9a-f]{64}$'`,
    ),
    check('entry_event_pick_heads_time_order', sql`checkpointed_at >= source_checked_at`),
  ],
);

/**
 * Durable migration/repair worklist for legacy entry pick rowsets that do not
 * satisfy the V2 exactly-15 contract.  Invalid scopes never receive a head.
 */
export const entryEventPickRepairsInCompetition = competition.table(
  'entry_event_pick_repairs',
  {
    seasonId: smallint('season_id').notNull(),
    entryId: integer('entry_id').notNull(),
    eventId: integer('event_id').notNull(),
    reason: text().notNull(),
    observedRowCount: integer('observed_row_count').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    status: text().notNull().default('PENDING'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.entryId, table.eventId],
      name: 'entry_event_pick_repairs_pkey',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'entry_event_pick_repairs_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'entry_event_pick_repairs_event_fk',
    }),
    index('entry_event_pick_repairs_pending_idx')
      .on(table.seasonId, table.eventId, table.observedAt)
      .where(sql`status = 'PENDING'::text`),
    check(
      'entry_event_pick_repairs_scope_valid',
      sql`season_id > 0 AND entry_id > 0 AND event_id > 0`,
    ),
    check('entry_event_pick_repairs_reason_valid', sql`btrim(reason) <> ''`),
    check('entry_event_pick_repairs_row_count_valid', sql`observed_row_count >= 0`),
    check(
      'entry_event_pick_repairs_status_valid',
      sql`status = ANY (ARRAY['PENDING', 'REPAIRED', 'IGNORED']::text[])`,
    ),
    check(
      'entry_event_pick_repairs_resolution_valid',
      sql`(status = 'PENDING' AND resolved_at IS NULL) OR (status IN ('REPAIRED', 'IGNORED') AND resolved_at IS NOT NULL)`,
    ),
  ],
);

/**
 * Redis-first V2 global checkpoint.  This is deliberately not an ops
 * publication row: it stores the complete same-event fallback payload that a
 * GraphQL process can serve when Redis is unavailable.  It is a single
 * checkpoint head per season/event; finalization is immutable at the writer.
 */
export const livePointsPublicationCheckpointsInCompetition = competition.table(
  'live_points_publication_checkpoints',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    publicationId: text('publication_id').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    state: text().notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull(),
    checkpointedAt: timestamp('checkpointed_at', { withTimezone: true, mode: 'date' }).notNull(),
    expectedNextCheckAt: timestamp('expected_next_check_at', { withTimezone: true, mode: 'date' }),
    revisions: jsonb().notNull(),
    eventLive: jsonb('event_live').notNull(),
    fixtures: jsonb().notNull(),
    eventLiveBytes: integer('event_live_bytes').notNull(),
    fixturesBytes: integer('fixtures_bytes').notNull(),
    eventLiveSha256: text('event_live_sha256').notNull(),
    fixturesSha256: text('fixtures_sha256').notNull(),
    eventLiveCount: integer('event_live_count').notNull(),
    fixturesCount: integer('fixtures_count').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.eventId],
      name: 'live_points_publication_checkpoints_pkey',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'live_points_publication_checkpoints_event_fk',
    }),
    unique('live_points_publication_checkpoints_publication_once').on(
      table.seasonId,
      table.eventId,
      table.publicationId,
    ),
    index('live_points_publication_checkpoints_event_generation_idx').on(
      table.seasonId,
      table.eventId,
      table.generation,
    ),
    check(
      'live_points_publication_checkpoints_identity_valid',
      sql`event_id > 0 AND generation > 0 AND publication_id ~ '^[0-9a-f-]{36}$' AND state = ANY (ARRAY['PRE_DEADLINE','PICKS_WAIT','PICKS_PROBE','PICKS_SYNC','LIVE_ACTIVE','BETWEEN_FIXTURES','DAY_SETTLING','GW_REVIEW','FINALIZED']::text[])`,
    ),
    check(
      'live_points_publication_checkpoints_payload_valid',
      sql`jsonb_typeof(revisions) = 'object' AND jsonb_typeof(event_live) = 'array' AND jsonb_typeof(fixtures) = 'array' AND event_live_count = jsonb_array_length(event_live) AND fixtures_count = jsonb_array_length(fixtures) AND event_live_count >= 0 AND fixtures_count >= 0 AND event_live_bytes >= 0 AND fixtures_bytes >= 0 AND event_live_sha256 ~ '^[0-9a-f]{64}$' AND fixtures_sha256 ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const entryEventTransfersInCompetition = competition.table(
  'entry_event_transfers',
  {
    seasonId: smallint('season_id').notNull(),
    transferId: integer('transfer_id').generatedByDefaultAsIdentity({
      name: 'entry_event_transfers_transfer_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    entryId: integer('entry_id').notNull(),
    eventId: integer('event_id').notNull(),
    elementInId: integer('element_in_id'),
    elementInCost: integer('element_in_cost'),
    elementInPoints: integer('element_in_points'),
    elementOutId: integer('element_out_id'),
    elementOutCost: integer('element_out_cost'),
    elementOutPoints: integer('element_out_points'),
    elementInPlayed: boolean('element_in_played'),
    transferTime: timestamp('transfer_time', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('entry_event_transfers_element_in_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.elementInId.asc().nullsLast())
      .where(sql`(element_in_id IS NOT NULL)`),
    index('entry_event_transfers_element_out_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.elementOutId.asc().nullsLast())
      .where(sql`(element_out_id IS NOT NULL)`),
    index('entry_event_transfers_entry_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.entryId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
      table.transferTime.asc().nullsLast(),
      table.transferId.asc().nullsLast(),
    ),
    index('entry_event_transfers_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('entry_event_transfers_in_player_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementInId.asc().nullsLast(),
    ),
    index('entry_event_transfers_out_player_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementOutId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'entry_event_transfers_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'entry_event_transfers_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'entry_event_transfers_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementInId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'entry_event_transfers_in_player_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementOutId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'entry_event_transfers_out_player_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.transferId], name: 'entry_event_transfers_pkey' }),
    unique('entry_event_transfers_business_unique')
      .on(
        table.seasonId,
        table.entryId,
        table.eventId,
        table.elementInId,
        table.elementOutId,
        table.transferTime,
      )
      .nullsNotDistinct(),
    check(
      'entry_event_transfers_ids_positive',
      sql`(transfer_id > 0) AND (entry_id > 0) AND (event_id > 0) AND ((element_in_id IS NULL) OR (element_in_id > 0)) AND ((element_out_id IS NULL) OR (element_out_id > 0))`,
    ),
  ],
);

export const tournamentBattleGroupResultsInCompetition = competition.table(
  'tournament_battle_group_results',
  {
    sourceResultId: integer('source_result_id').generatedByDefaultAsIdentity({
      name: 'tournament_battle_group_results_source_result_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    tournamentId: integer('tournament_id').notNull(),
    seasonId: smallint('season_id').notNull(),
    groupId: integer('group_id').notNull(),
    eventId: integer('event_id').notNull(),
    homeIndex: integer('home_index').notNull(),
    homeEntryId: integer('home_entry_id'),
    homeNetPoints: integer('home_net_points'),
    homeRank: integer('home_rank'),
    homeMatchPoints: integer('home_match_points'),
    awayIndex: integer('away_index').notNull(),
    awayEntryId: integer('away_entry_id'),
    awayNetPoints: integer('away_net_points'),
    awayRank: integer('away_rank'),
    awayMatchPoints: integer('away_match_points'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    officialMatchId: integer('official_match_id'),
    sourceOrder: integer('source_order'),
    homeIsAverage: boolean('home_is_average').default(false).notNull(),
    awayIsAverage: boolean('away_is_average').default(false).notNull(),
    isBye: boolean('is_bye').default(false).notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('tournament_battle_group_results_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    index('tournament_battle_results_away_entry_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.awayEntryId.asc().nullsLast(),
    ),
    index('tournament_battle_results_home_entry_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.homeEntryId.asc().nullsLast(),
    ),
    index('tournament_battle_results_tournament_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    uniqueIndex('tournament_battle_group_results_official_match_unique')
      .using('btree', table.tournamentId.asc().nullsLast(), table.officialMatchId.asc().nullsLast())
      .where(sql`official_match_id IS NOT NULL`),
    index('tournament_battle_group_results_official_display_idx')
      .using(
        'btree',
        table.tournamentId.asc().nullsLast(),
        table.eventId.asc().nullsLast(),
        table.sourceOrder.asc().nullsLast(),
        table.officialMatchId.asc().nullsLast(),
      )
      .where(sql`official_match_id IS NOT NULL`),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'tournament_battle_group_results_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.awayEntryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_battle_results_away_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournament_battle_results_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.homeEntryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_battle_results_home_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'tournament_battle_results_tournament_fk',
    }),
    primaryKey({
      columns: [table.tournamentId, table.sourceResultId],
      name: 'tournament_battle_group_results_pkey',
    }),
    unique('tournament_battle_group_results_business_unique').on(
      table.tournamentId,
      table.groupId,
      table.eventId,
      table.homeIndex,
      table.awayIndex,
    ),
    check(
      'tournament_battle_group_results_distinct_entries',
      sql`home_entry_id IS NULL OR away_entry_id IS NULL OR home_entry_id <> away_entry_id`,
    ),
    check(
      'tournament_battle_group_results_ids_positive',
      sql`(source_result_id > 0) AND (tournament_id > 0) AND (group_id > 0) AND (event_id > 0) AND (official_match_id IS NULL OR official_match_id > 0) AND (source_order IS NULL OR source_order >= 0)`,
    ),
    check(
      'tournament_battle_group_results_side_contract',
      sql`((home_is_average AND home_entry_id IS NULL) OR (NOT home_is_average AND home_entry_id > 0)) AND ((away_is_average AND away_entry_id IS NULL) OR (NOT away_is_average AND away_entry_id > 0)) AND NOT (home_is_average AND away_is_average) AND (NOT (home_is_average OR away_is_average) OR official_match_id IS NOT NULL) AND (NOT is_bye OR official_match_id IS NOT NULL)`,
    ),
    check(
      'tournament_battle_group_results_official_order_contract',
      sql`(official_match_id IS NULL AND source_order IS NULL) OR (official_match_id IS NOT NULL AND source_order IS NOT NULL)`,
    ),
  ],
);

export const tournamentPointsGroupResultsInCompetition = competition.table(
  'tournament_points_group_results',
  {
    sourceResultId: integer('source_result_id').generatedByDefaultAsIdentity({
      name: 'tournament_points_group_results_source_result_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    tournamentId: integer('tournament_id').notNull(),
    seasonId: smallint('season_id').notNull(),
    groupId: integer('group_id').notNull(),
    eventId: integer('event_id').notNull(),
    entryId: integer('entry_id').notNull(),
    eventGroupRank: integer('event_group_rank'),
    eventPoints: integer('event_points'),
    eventCost: integer('event_cost'),
    eventNetPoints: integer('event_net_points'),
    eventRank: integer('event_rank'),
    cumulativeTransfers: integer('cumulative_transfers').default(0).notNull(),
    cumulativeCosts: integer('cumulative_costs').default(0).notNull(),
    cumulativeBenchPoints: integer('cumulative_bench_points').default(0).notNull(),
    cumulativeAutoSubPoints: integer('cumulative_auto_sub_points').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('tournament_points_group_results_entry_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.entryId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('tournament_points_group_results_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    index('tournament_points_results_tournament_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'tournament_points_group_results_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_points_results_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournament_points_results_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'tournament_points_results_tournament_fk',
    }),
    primaryKey({
      columns: [table.tournamentId, table.sourceResultId],
      name: 'tournament_points_group_results_pkey',
    }),
    unique('tournament_points_group_results_business_unique').on(
      table.tournamentId,
      table.eventId,
      table.entryId,
    ),
    check(
      'tournament_points_group_results_ids_positive',
      sql`(source_result_id > 0) AND (tournament_id > 0) AND (group_id > 0) AND (event_id > 0) AND (entry_id > 0)`,
    ),
    check(
      'tournament_points_group_results_cumulative_nonnegative',
      sql`(cumulative_transfers >= 0) AND (cumulative_costs >= 0) AND (cumulative_bench_points >= 0) AND (cumulative_auto_sub_points >= 0)`,
    ),
  ],
);

export const tournamentKnockoutResultsInCompetition = competition.table(
  'tournament_knockout_results',
  {
    sourceResultId: integer('source_result_id').generatedByDefaultAsIdentity({
      name: 'tournament_knockout_results_source_result_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    tournamentId: integer('tournament_id').notNull(),
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    matchId: integer('match_id').notNull(),
    playAgainstId: integer('play_against_id').notNull(),
    homeEntryId: integer('home_entry_id'),
    homeNetPoints: integer('home_net_points'),
    homeGoalsScored: integer('home_goals_scored'),
    homeGoalsConceded: integer('home_goals_conceded'),
    awayEntryId: integer('away_entry_id'),
    awayNetPoints: integer('away_net_points'),
    awayGoalsScored: integer('away_goals_scored'),
    awayGoalsConceded: integer('away_goals_conceded'),
    matchWinner: integer('match_winner'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    officialMatchId: integer('official_match_id'),
    sourceOrder: integer('source_order'),
    knockoutName: text('knockout_name'),
    tiebreak: text(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('tournament_knockout_results_away_entry_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.awayEntryId.asc().nullsLast(),
    ),
    index('tournament_knockout_results_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    index('tournament_knockout_results_home_entry_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.homeEntryId.asc().nullsLast(),
    ),
    index('tournament_knockout_results_tournament_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    index('tournament_knockout_results_winner_entry_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.matchWinner.asc().nullsLast(),
    ),
    uniqueIndex('tournament_knockout_results_official_match_unique')
      .using('btree', table.tournamentId.asc().nullsLast(), table.officialMatchId.asc().nullsLast())
      .where(sql`official_match_id IS NOT NULL`),
    index('tournament_knockout_results_official_display_idx')
      .using(
        'btree',
        table.tournamentId.asc().nullsLast(),
        table.eventId.asc().nullsLast(),
        table.sourceOrder.asc().nullsLast(),
        table.officialMatchId.asc().nullsLast(),
      )
      .where(sql`official_match_id IS NOT NULL`),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'tournament_knockout_results_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.awayEntryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_knockout_results_away_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournament_knockout_results_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.homeEntryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_knockout_results_home_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'tournament_knockout_results_tournament_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.matchWinner],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_knockout_results_winner_entry_fk',
    }),
    primaryKey({
      columns: [table.tournamentId, table.sourceResultId],
      name: 'tournament_knockout_results_pkey',
    }),
    unique('tournament_knockout_results_business_unique').on(
      table.tournamentId,
      table.eventId,
      table.matchId,
      table.playAgainstId,
    ),
    check(
      'tournament_knockout_results_ids_positive',
      sql`(source_result_id > 0) AND (tournament_id > 0) AND (event_id > 0) AND (match_id > 0) AND (play_against_id > 0)`,
    ),
    check(
      'tournament_knockout_results_distinct_entries',
      sql`(home_entry_id IS NULL) OR (away_entry_id IS NULL) OR (home_entry_id <> away_entry_id)`,
    ),
    check(
      'tournament_knockout_results_official_fields_valid',
      sql`(official_match_id IS NULL OR official_match_id > 0) AND (source_order IS NULL OR source_order >= 0) AND ((official_match_id IS NULL AND source_order IS NULL) OR (official_match_id IS NOT NULL AND source_order IS NOT NULL))`,
    ),
  ],
);

export const entryEventCupResultsInCompetition = competition.table(
  'entry_event_cup_results',
  {
    seasonId: smallint('season_id').notNull(),
    sourceResultId: integer('source_result_id')
      .generatedByDefaultAsIdentity({
        name: 'entry_event_cup_results_source_result_id_seq',
      })
      .notNull(),
    entryId: integer('entry_id').notNull(),
    eventId: integer('event_id').notNull(),
    opponentEntryId: integer('opponent_entry_id'),
    opponentName: text('opponent_name'),
    result: cupResultInCompetition().notNull(),
    entryPoints: integer('entry_points').notNull(),
    opponentPoints: integer('opponent_points').notNull(),
    entryName: text('entry_name'),
    playerName: text('player_name'),
    againstEntryName: text('against_entry_name'),
    againstPlayerName: text('against_player_name'),
    eventPoints: integer('event_points'),
    againstEntryId: integer('against_entry_id'),
    againstEventPoints: integer('against_event_points'),
    sourceSeasonCode: text('source_season_code'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('entry_event_cup_results_entry_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.entryId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('entry_event_cup_results_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'entry_event_cup_results_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'entry_event_cup_results_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'entry_event_cup_results_event_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.sourceResultId],
      name: 'entry_event_cup_results_pkey',
    }),
    unique('entry_event_cup_results_business_unique').on(
      table.seasonId,
      table.entryId,
      table.eventId,
    ),
    check(
      'entry_event_cup_results_ids_positive',
      sql`(source_result_id > 0) AND (entry_id > 0) AND (event_id > 0) AND ((opponent_entry_id IS NULL) OR (opponent_entry_id > 0)) AND ((against_entry_id IS NULL) OR (against_entry_id > 0))`,
    ),
  ],
);

export const tournamentKnockoutsInCompetition = competition.table(
  'tournament_knockouts',
  {
    sourceKnockoutId: integer('source_knockout_id').generatedByDefaultAsIdentity({
      name: 'tournament_knockouts_source_knockout_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    tournamentId: integer('tournament_id').notNull(),
    seasonId: smallint('season_id').notNull(),
    round: integer().notNull(),
    startedEventId: integer('started_event_id'),
    endedEventId: integer('ended_event_id'),
    matchId: integer('match_id').notNull(),
    nextMatchId: integer('next_match_id'),
    homeEntryId: integer('home_entry_id'),
    homeNetPoints: integer('home_net_points'),
    homeGoalsScored: integer('home_goals_scored'),
    homeGoalsConceded: integer('home_goals_conceded'),
    homeWins: integer('home_wins'),
    awayEntryId: integer('away_entry_id'),
    awayNetPoints: integer('away_net_points'),
    awayGoalsScored: integer('away_goals_scored'),
    awayGoalsConceded: integer('away_goals_conceded'),
    awayWins: integer('away_wins'),
    roundWinner: integer('round_winner'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('tournament_knockouts_away_entry_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.awayEntryId.asc().nullsLast(),
    ),
    index('tournament_knockouts_away_entry_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.awayEntryId.asc().nullsLast())
      .where(sql`(away_entry_id IS NOT NULL)`),
    index('tournament_knockouts_end_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.endedEventId.asc().nullsLast(),
    ),
    index('tournament_knockouts_home_entry_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.homeEntryId.asc().nullsLast(),
    ),
    index('tournament_knockouts_home_entry_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.homeEntryId.asc().nullsLast())
      .where(sql`(home_entry_id IS NOT NULL)`),
    index('tournament_knockouts_season_fk_idx').using('btree', table.seasonId.asc().nullsLast()),
    index('tournament_knockouts_start_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.startedEventId.asc().nullsLast(),
    ),
    index('tournament_knockouts_tournament_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    index('tournament_knockouts_winner_entry_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.roundWinner.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'tournament_knockouts_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.awayEntryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_knockouts_away_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.endedEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournament_knockouts_end_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.homeEntryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_knockouts_home_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.startedEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournament_knockouts_start_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'tournament_knockouts_tournament_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.roundWinner],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_knockouts_winner_entry_fk',
    }),
    primaryKey({ columns: [table.tournamentId, table.matchId], name: 'tournament_knockouts_pkey' }),
    unique('tournament_knockouts_source_id_unique').on(table.sourceKnockoutId),
    check(
      'tournament_knockouts_ids_positive',
      sql`(source_knockout_id > 0) AND (tournament_id > 0) AND (round > 0) AND (match_id > 0)`,
    ),
    check(
      'tournament_knockouts_event_order',
      sql`(ended_event_id IS NULL) OR (started_event_id IS NULL) OR (ended_event_id >= started_event_id)`,
    ),
  ],
);

export const entryEventResultsInCompetition = competition.table(
  'entry_event_results',
  {
    seasonId: smallint('season_id').notNull(),
    entryId: integer('entry_id').notNull(),
    eventId: integer('event_id').notNull(),
    sourceResultId: integer('source_result_id')
      .generatedByDefaultAsIdentity({
        name: 'entry_event_results_source_result_id_seq',
      })
      .notNull(),
    eventPoints: integer('event_points').default(0).notNull(),
    eventTransfers: integer('event_transfers').default(0).notNull(),
    eventTransfersCost: integer('event_transfers_cost').default(0).notNull(),
    eventNetPoints: integer('event_net_points').default(0).notNull(),
    eventBenchPoints: integer('event_bench_points'),
    eventAutoSubPoints: integer('event_auto_sub_points'),
    eventRank: integer('event_rank'),
    eventChip: chipInCompetition('event_chip'),
    playedCaptainElementId: integer('played_captain_element_id'),
    captainPoints: integer('captain_points'),
    automaticSubstitutions: jsonb('automatic_substitutions'),
    overallPoints: integer('overall_points').default(0).notNull(),
    overallRank: integer('overall_rank').default(0).notNull(),
    teamValue: integer('team_value'),
    bank: integer(),
    richSyncedAt: timestamp('rich_synced_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /** Immutable picks payload captured with the finalized result. */
    eventPicks: jsonb('event_picks').default([]).notNull(),
  },
  (table) => [
    index('entry_event_results_captain_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.playedCaptainElementId.asc().nullsLast(),
    ),
    index('entry_event_results_captain_idx')
      .using(
        'btree',
        table.seasonId.asc().nullsLast(),
        table.playedCaptainElementId.asc().nullsLast(),
      )
      .where(sql`(played_captain_element_id IS NOT NULL)`),
    index('entry_event_results_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
      table.entryId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'entry_event_results_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.playedCaptainElementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'entry_event_results_captain_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'entry_event_results_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'entry_event_results_event_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.entryId, table.eventId],
      name: 'entry_event_results_pkey',
    }),
    unique('entry_event_results_source_id_unique').on(table.sourceResultId),
    check(
      'entry_event_results_ids_positive',
      sql`(entry_id > 0) AND (event_id > 0) AND (source_result_id > 0) AND ((played_captain_element_id IS NULL) OR (played_captain_element_id > 0))`,
    ),
    check(
      'entry_event_results_transfer_counts_nonnegative',
      sql`(event_transfers >= 0) AND (event_transfers_cost >= 0)`,
    ),
    check(
      'entry_event_results_rank_nonnegative',
      sql`((event_rank IS NULL) OR (event_rank >= 0)) AND (overall_rank >= 0)`,
    ),
    check(
      'entry_event_results_auto_sub_array',
      sql`(automatic_substitutions IS NULL) OR (jsonb_typeof(automatic_substitutions) = 'array'::text)`,
    ),
    check('entry_event_results_event_picks_array', sql`jsonb_typeof(event_picks) = 'array'::text`),
  ],
);

export const myFplSnapshotPublicationsInCompetition = competition.table(
  'my_fpl_snapshot_publications',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    revision: bigint('revision', { mode: 'number' })
      .default(sql`nextval('competition.my_fpl_snapshot_revision_seq'::regclass)`)
      .notNull(),
    snapshotDate: date('snapshot_date').notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    kind: text().notNull(),
    active: boolean().default(false).notNull(),
    expectedEntryCount: integer('expected_entry_count').notNull(),
    readyEntryCount: integer('ready_entry_count').notNull(),
    emptyEntryCount: integer('empty_entry_count').notNull(),
    expectedTournamentCount: integer('expected_tournament_count').notNull(),
    readyTournamentCount: integer('ready_tournament_count').notNull(),
    contentSha256: text('content_sha256').notNull(),
    overrideActor: text('override_actor'),
    overrideReason: text('override_reason'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    scoreSource: text('score_source'),
    livePublicationId: uuid('live_publication_id'),
    liveRevision: text('live_revision'),
    algorithmVersion: text('algorithm_version'),
    sourceMinCheckedAt: timestamp('source_min_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    sourceMaxCheckedAt: timestamp('source_max_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    notApplicableEntryCount: integer('not_applicable_entry_count').default(0).notNull(),
  },
  (table) => [
    index('my_fpl_snapshot_publications_gc_idx').on(
      table.seasonId,
      table.eventId,
      table.publishedAt.desc(),
    ),
    index('my_fpl_snapshot_publications_retention_idx')
      .on(table.seasonId, table.eventId, table.updatedAt.desc())
      .where(sql`NOT active`),
    uniqueIndex('my_fpl_snapshot_publications_active_key')
      .on(table.seasonId, table.eventId)
      .where(sql`active`),
    uniqueIndex('my_fpl_snapshot_publications_idempotency_key')
      .on(table.seasonId, table.eventId, table.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'my_fpl_snapshot_publications_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'my_fpl_snapshot_publications_event_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.revision],
      name: 'my_fpl_snapshot_publications_pkey',
    }),
    check(
      'my_fpl_snapshot_publications_kind_check',
      sql`kind = ANY (ARRAY['PROVISIONAL'::text, 'FINAL'::text])`,
    ),
    check(
      'my_fpl_snapshot_publications_counts_check',
      sql`expected_entry_count >= 0 AND ready_entry_count >= 0 AND empty_entry_count >= 0 AND ready_entry_count + empty_entry_count = expected_entry_count AND expected_tournament_count >= 0 AND ready_tournament_count >= 0 AND ready_tournament_count <= expected_tournament_count`,
    ),
    check(
      'my_fpl_snapshot_publications_eligibility_counts_check',
      sql`not_applicable_entry_count >= 0`,
    ),
    check('my_fpl_snapshot_publications_hash_check', sql`content_sha256 ~ '^[0-9a-f]{64}$'::text`),
    check(
      'my_fpl_snapshot_publications_score_source_check',
      sql`score_source IS NULL OR score_source IN ('FPL_EVENT_LIVE', 'FPL_FINAL_RESULT')`,
    ),
    check(
      'my_fpl_snapshot_publications_source_span_check',
      sql`source_min_checked_at IS NULL OR source_max_checked_at IS NULL OR source_min_checked_at <= source_max_checked_at`,
    ),
    check(
      'my_fpl_snapshot_publications_override_check',
      sql`((override_actor IS NULL AND override_reason IS NULL AND idempotency_key IS NULL) OR (kind = 'FINAL'::text AND override_actor IS NOT NULL AND override_reason IS NOT NULL AND idempotency_key IS NOT NULL AND btrim(override_actor) <> '' AND btrim(override_reason) <> '' AND btrim(idempotency_key) <> ''))`,
    ),
  ],
);

export const myFplSnapshotPublicationOutboxInCompetition = competition.table(
  'my_fpl_snapshot_publication_outbox',
  {
    outboxId: uuid('outbox_id').defaultRandom().primaryKey().notNull(),
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    manifest: jsonb().notNull(),
    status: text().default('PENDING').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    attempts: integer().default(0).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('my_fpl_snapshot_publication_outbox_revision_key').on(
      table.seasonId,
      table.eventId,
      table.revision,
    ),
    index('my_fpl_snapshot_publication_outbox_pending_idx')
      .on(table.availableAt, table.outboxId)
      .where(sql`status IN ('PENDING', 'PROCESSING') AND delivered_at IS NULL`),
    index('my_fpl_snapshot_publication_outbox_reclaim_idx')
      .on(table.leaseExpiresAt, table.outboxId)
      .where(sql`status = 'PROCESSING' AND delivered_at IS NULL`),
    foreignKey({
      columns: [table.seasonId, table.eventId, table.revision],
      foreignColumns: [
        myFplSnapshotPublicationsInCompetition.seasonId,
        myFplSnapshotPublicationsInCompetition.eventId,
        myFplSnapshotPublicationsInCompetition.revision,
      ],
      name: 'my_fpl_snapshot_publication_outbox_scope_fk',
    }).onDelete('cascade'),
    check(
      'my_fpl_snapshot_publication_outbox_status_check',
      sql`status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'DELIVERED'::text, 'SUPERSEDED'::text, 'FAILED'::text])`,
    ),
    check('my_fpl_snapshot_publication_outbox_attempts_check', sql`attempts >= 0`),
    check(
      'my_fpl_snapshot_publication_outbox_manifest_check',
      sql`jsonb_typeof(manifest) = 'object'::text`,
    ),
    check(
      'my_fpl_snapshot_publication_outbox_lease_check',
      sql`(lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)`,
    ),
  ],
);

/**
 * Durable tombstones for Redis manifests removed by tournament deletion.
 *
 * There is intentionally no foreign key to a publication or tournament: the
 * deletion transaction removes both records, while this receipt must remain
 * available for a later Redis retry.
 */
export const myFplSnapshotInvalidationOutboxInCompetition = competition.table(
  'my_fpl_snapshot_invalidation_outbox',
  {
    outboxId: uuid('outbox_id').defaultRandom().primaryKey().notNull(),
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    tournamentId: integer('tournament_id').notNull(),
    reason: text().default('TOURNAMENT_DELETED').notNull(),
    status: text().default('PENDING').notNull(),
    attempts: integer().default(0).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('my_fpl_snapshot_invalidation_outbox_revision_key').on(
      table.seasonId,
      table.eventId,
      table.revision,
    ),
    index('my_fpl_snapshot_invalidation_outbox_pending_idx')
      .on(table.availableAt, table.outboxId)
      .where(sql`status IN ('PENDING', 'FAILED') AND delivered_at IS NULL`),
    index('my_fpl_snapshot_invalidation_outbox_reclaim_idx')
      .on(table.leaseExpiresAt, table.outboxId)
      .where(sql`status = 'PROCESSING' AND delivered_at IS NULL`),
    index('my_fpl_snapshot_invalidation_outbox_tournament_idx').on(
      table.seasonId,
      table.tournamentId,
      table.status,
      table.outboxId,
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'my_fpl_snapshot_invalidation_outbox_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'my_fpl_snapshot_invalidation_outbox_event_fk',
    }),
    check('my_fpl_snapshot_invalidation_outbox_tournament_id_check', sql`tournament_id > 0`),
    check('my_fpl_snapshot_invalidation_outbox_reason_check', sql`reason = 'TOURNAMENT_DELETED'`),
    check(
      'my_fpl_snapshot_invalidation_outbox_status_check',
      sql`status = ANY (ARRAY['PENDING'::text, 'PROCESSING'::text, 'DELIVERED'::text, 'SUPERSEDED'::text, 'FAILED'::text])`,
    ),
    check('my_fpl_snapshot_invalidation_outbox_attempts_check', sql`attempts >= 0`),
    check(
      'my_fpl_snapshot_invalidation_outbox_lease_check',
      sql`(lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)`,
    ),
  ],
);

export const myFplSnapshotEntriesInCompetition = competition.table(
  'my_fpl_snapshot_entries',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    entryId: integer('entry_id').notNull(),
    picksCount: integer('picks_count').notNull(),
    isEmpty: boolean('is_empty').default(false).notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('my_fpl_snapshot_entries_active_lookup_idx').on(
      table.seasonId,
      table.eventId,
      table.entryId,
      table.revision.desc(),
    ),
    foreignKey({
      columns: [table.seasonId, table.eventId, table.revision],
      foreignColumns: [
        myFplSnapshotPublicationsInCompetition.seasonId,
        myFplSnapshotPublicationsInCompetition.eventId,
        myFplSnapshotPublicationsInCompetition.revision,
      ],
      name: 'my_fpl_snapshot_entries_publication_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'my_fpl_snapshot_entries_entry_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.revision, table.entryId],
      name: 'my_fpl_snapshot_entries_pkey',
    }),
    check('my_fpl_snapshot_entries_picks_check', sql`picks_count >= 0 AND picks_count <= 15`),
    check('my_fpl_snapshot_entries_payload_check', sql`jsonb_typeof(payload) = 'object'::text`),
  ],
);

export const myFplSnapshotTournamentRowsInCompetition = competition.table(
  'my_fpl_snapshot_tournament_rows',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    tournamentId: integer('tournament_id').notNull(),
    entryId: integer('entry_id').notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('my_fpl_snapshot_tournament_rows_board_idx').on(
      table.seasonId,
      table.eventId,
      table.tournamentId,
      table.revision,
      table.entryId,
    ),
    foreignKey({
      columns: [table.seasonId, table.eventId, table.revision],
      foreignColumns: [
        myFplSnapshotPublicationsInCompetition.seasonId,
        myFplSnapshotPublicationsInCompetition.eventId,
        myFplSnapshotPublicationsInCompetition.revision,
      ],
      name: 'my_fpl_snapshot_tournament_rows_publication_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'my_fpl_snapshot_tournament_rows_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'my_fpl_snapshot_tournament_rows_tournament_fk',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.revision, table.tournamentId, table.entryId],
      name: 'my_fpl_snapshot_tournament_rows_pkey',
    }),
    check(
      'my_fpl_snapshot_tournament_rows_payload_check',
      sql`jsonb_typeof(payload) = 'object'::text`,
    ),
  ],
);

export const myFplSnapshotTournamentAggregatesInCompetition = competition.table(
  'my_fpl_snapshot_tournament_aggregates',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    tournamentId: integer('tournament_id').notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.seasonId, table.eventId, table.revision],
      foreignColumns: [
        myFplSnapshotPublicationsInCompetition.seasonId,
        myFplSnapshotPublicationsInCompetition.eventId,
        myFplSnapshotPublicationsInCompetition.revision,
      ],
      name: 'my_fpl_snapshot_tournament_aggregates_publication_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'my_fpl_snapshot_tournament_aggregates_tournament_fk',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.revision, table.tournamentId],
      name: 'my_fpl_snapshot_tournament_aggregates_pkey',
    }),
    check(
      'my_fpl_snapshot_tournament_aggregates_payload_check',
      sql`jsonb_typeof(payload) = 'object'::text`,
    ),
  ],
);

export const tournamentGroupsInCompetition = competition.table(
  'tournament_groups',
  {
    sourceGroupRowId: integer('source_group_row_id').generatedByDefaultAsIdentity({
      name: 'tournament_groups_source_group_row_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    tournamentId: integer('tournament_id').notNull(),
    seasonId: smallint('season_id').notNull(),
    groupId: integer('group_id').notNull(),
    groupName: text('group_name').notNull(),
    groupIndex: integer('group_index').notNull(),
    entryId: integer('entry_id').notNull(),
    startedEventId: integer('started_event_id'),
    endedEventId: integer('ended_event_id'),
    groupPoints: integer('group_points'),
    groupRank: integer('group_rank'),
    played: integer(),
    won: integer(),
    drawn: integer(),
    lost: integer(),
    totalPoints: integer('total_points'),
    totalTransfersCost: integer('total_transfers_cost'),
    totalNetPoints: integer('total_net_points'),
    qualified: integer(),
    overallRank: integer('overall_rank'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('tournament_groups_end_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.endedEventId.asc().nullsLast(),
    ),
    index('tournament_groups_entry_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.entryId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    index('tournament_groups_start_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.startedEventId.asc().nullsLast(),
    ),
    index('tournament_groups_tournament_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.tournamentId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'tournament_groups_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.endedEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournament_groups_end_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'tournament_groups_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.startedEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'tournament_groups_start_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'tournament_groups_tournament_fk',
    }),
    primaryKey({
      columns: [table.tournamentId, table.groupId, table.entryId],
      name: 'tournament_groups_pkey',
    }),
    unique('tournament_groups_source_id_unique').on(table.sourceGroupRowId),
    check(
      'tournament_groups_ids_positive',
      sql`(source_group_row_id > 0) AND (tournament_id > 0) AND (group_id > 0) AND (entry_id > 0)`,
    ),
    check('tournament_groups_name_nonempty', sql`btrim(group_name) <> ''::text`),
    check(
      'tournament_groups_event_order',
      sql`(ended_event_id IS NULL) OR (started_event_id IS NULL) OR (ended_event_id >= started_event_id)`,
    ),
  ],
);

export const entriesInCompetition = competition.table(
  'entries',
  {
    seasonId: smallint('season_id').notNull(),
    entryId: integer('entry_id').notNull(),
    entryName: text('entry_name').notNull(),
    playerName: text('player_name').notNull(),
    region: text(),
    startedEvent: integer('started_event'),
    overallPoints: integer('overall_points'),
    overallRank: integer('overall_rank'),
    bank: integer(),
    teamValue: integer('team_value'),
    totalTransfers: integer('total_transfers'),
    lastEntryName: text('last_entry_name'),
    lastOverallPoints: integer('last_overall_points'),
    lastOverallRank: integer('last_overall_rank'),
    lastTeamValue: integer('last_team_value'),
    lastBank: integer('last_bank'),
    usedEntryNames: text('used_entry_names')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    lastEventId: integer('last_event_id').default(0).notNull(),
    snapshotSyncedThroughEventId: integer('snapshot_synced_through_event_id'),
    transfersSyncedThroughEventId: integer('transfers_synced_through_event_id'),
    transfersSourceCheckedAt: timestamp('transfers_source_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    pastSeasonsCheckedAt: timestamp('past_seasons_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    pastSeasonsCount: integer('past_seasons_count'),
  },
  (table) => [
    index('entries_entry_id_idx').using(
      'btree',
      table.entryId.asc().nullsLast(),
      table.seasonId.desc().nullsFirst(),
    ),
    index('entries_entry_name_trgm_idx').using(
      'gin',
      sql`${table.entryName} extensions.gin_trgm_ops`,
    ),
    index('entries_player_name_trgm_idx').using(
      'gin',
      sql`${table.playerName} extensions.gin_trgm_ops`,
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'entries_season_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.entryId], name: 'entries_pkey' }),
    check('entries_entry_id_positive', sql`entry_id > 0`),
    check(
      'entries_names_nonempty',
      sql`(btrim(entry_name) <> ''::text) AND (btrim(player_name) <> ''::text)`,
    ),
    check(
      'entries_event_ids_valid',
      sql`((started_event IS NULL) OR (started_event > 0)) AND (last_event_id >= 0) AND ((snapshot_synced_through_event_id IS NULL) OR (snapshot_synced_through_event_id >= 0)) AND ((transfers_synced_through_event_id IS NULL) OR (transfers_synced_through_event_id >= 0))`,
    ),
    check(
      'entries_past_seasons_count_nonnegative',
      sql`(past_seasons_count IS NULL) OR (past_seasons_count >= 0)`,
    ),
  ],
);

export const entryPastSeasonsInCompetition = competition.table(
  'entry_past_seasons',
  {
    entrySeasonId: smallint('entry_season_id').notNull(),
    entryId: integer('entry_id').notNull(),
    sourceSeasonId: smallint('source_season_id').notNull(),
    sourceSeasonLabel: text('source_season_label').notNull(),
    totalPoints: integer('total_points').default(0).notNull(),
    overallRank: integer('overall_rank').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('entry_past_seasons_entry_idx').using(
      'btree',
      table.entrySeasonId.asc().nullsLast(),
      table.entryId.asc().nullsLast(),
      table.sourceSeasonId.desc().nullsFirst(),
    ),
    foreignKey({
      columns: [table.entrySeasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'entry_past_seasons_entry_fk',
    }),
    foreignKey({
      columns: [table.entrySeasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'entry_past_seasons_entry_season_fk',
    }),
    foreignKey({
      columns: [table.sourceSeasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'entry_past_seasons_source_season_fk',
    }),
    primaryKey({
      columns: [table.entrySeasonId, table.entryId, table.sourceSeasonId],
      name: 'entry_past_seasons_pkey',
    }),
    check('entry_past_seasons_ids_positive', sql`(entry_id > 0) AND (source_season_id > 0)`),
    check(
      'entry_past_seasons_totals_nonnegative',
      sql`(total_points >= 0) AND (overall_rank >= 0)`,
    ),
    check(
      'entry_past_seasons_label_format',
      sql`source_season_label ~ '^[0-9]{4}/[0-9]{2}$'::text`,
    ),
  ],
);

export const leagueEventResultsInCompetition = competition.table(
  'league_event_results',
  {
    seasonId: smallint('season_id').notNull(),
    sourceResultId: integer('source_result_id').generatedByDefaultAsIdentity({
      name: 'league_event_results_source_result_id_seq',
      startWith: 1,
      increment: 1,
      minValue: 1,
      maxValue: 2147483647,
      cache: 1,
    }),
    leagueId: integer('league_id').notNull(),
    leagueType: leagueTypeInCompetition('league_type').notNull(),
    entryId: integer('entry_id').notNull(),
    eventId: integer('event_id').notNull(),
    eventPoints: integer('event_points').default(0).notNull(),
    eventTransfers: integer('event_transfers').default(0).notNull(),
    eventTransfersCost: integer('event_transfers_cost').default(0).notNull(),
    eventNetPoints: integer('event_net_points').default(0).notNull(),
    overallPoints: integer('overall_points').default(0).notNull(),
    overallRank: integer('overall_rank').default(0).notNull(),
    entryName: text('entry_name'),
    playerName: text('player_name'),
    teamValue: integer('team_value'),
    bank: integer(),
    eventBenchPoints: integer('event_bench_points'),
    eventAutoSubPoints: integer('event_auto_sub_points'),
    eventRank: integer('event_rank'),
    eventChip: chipInCompetition('event_chip'),
    captainElementId: integer('captain_element_id'),
    captainPoints: integer('captain_points'),
    captainBlank: boolean('captain_blank'),
    viceCaptainElementId: integer('vice_captain_element_id'),
    viceCaptainPoints: integer('vice_captain_points'),
    viceCaptainBlank: boolean('vice_captain_blank'),
    playedCaptainElementId: integer('played_captain_element_id'),
    highestScoreElementId: integer('highest_score_element_id'),
    highestScorePoints: integer('highest_score_points'),
    highestScoreBlank: boolean('highest_score_blank'),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    sourceLiveCheckedAt: timestamp('source_live_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    sourcePicksCheckedAt: timestamp('source_picks_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    index('league_event_results_captain_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.captainElementId.asc().nullsLast(),
    ),
    index('league_event_results_entry_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.entryId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('league_event_results_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
      table.leagueId.asc().nullsLast(),
      table.leagueType.asc().nullsLast(),
    ),
    index('league_event_results_high_score_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.highestScoreElementId.asc().nullsLast(),
    ),
    index('league_event_results_played_captain_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.playedCaptainElementId.asc().nullsLast(),
    ),
    index('league_event_results_vice_captain_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.viceCaptainElementId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'league_event_results_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.captainElementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'league_event_results_captain_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.entryId],
      foreignColumns: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
      name: 'league_event_results_entry_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'league_event_results_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.highestScoreElementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'league_event_results_high_score_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.playedCaptainElementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'league_event_results_played_captain_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.viceCaptainElementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'league_event_results_vice_captain_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.sourceResultId],
      name: 'league_event_results_pkey',
    }),
    unique('league_event_results_business_unique').on(
      table.seasonId,
      table.leagueId,
      table.leagueType,
      table.entryId,
      table.eventId,
    ),
    check(
      'league_event_results_ids_positive',
      sql`(source_result_id > 0) AND (league_id > 0) AND (entry_id > 0) AND (event_id > 0)`,
    ),
    check(
      'league_event_results_transfer_counts_nonnegative',
      sql`(event_transfers >= 0) AND (event_transfers_cost >= 0)`,
    ),
    check(
      'league_event_results_source_pair_valid',
      sql`((source_live_checked_at IS NULL) AND (source_picks_checked_at IS NULL)) OR ((source_live_checked_at IS NOT NULL) AND (source_picks_checked_at IS NOT NULL))`,
    ),
  ],
);
