// Canonical PostgreSQL schema mapping shared by runtime readers and writers.
import {
  pgSchema,
  foreignKey,
  unique,
  check,
  smallint,
  text,
  jsonb,
  timestamp,
  type AnyPgColumn,
  index,
  uuid,
  integer,
  boolean,
  uniqueIndex,
  bigint,
  date,
  numeric,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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

export const datasetPublicationRevisionsInOps = ops.sequence('dataset_publication_revisions', {
  startWith: '1',
  increment: '1',
  minValue: '1',
  maxValue: '9223372036854775807',
  cache: '1',
  cycle: false,
});

export const playerMarketSnapshotSourceIdsInFpl = fpl.sequence(
  'player_market_snapshots_source_snapshot_id_seq',
  {
    startWith: '1',
    increment: '1',
    minValue: '1',
    maxValue: '9223372036854775807',
    cache: '1',
    cycle: false,
  },
);

export const seasonImportsInOps = ops.table(
  'season_imports',
  {
    seasonId: smallint('season_id').primaryKey().notNull(),
    seasonCode: text('season_code').notNull(),
    status: text().notNull(),
    reason: text(),
    sourceCoreRevision: text('source_core_revision'),
    itemManifest: jsonb('item_manifest').default([]).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'season_imports_season_fk',
    }),
    unique('season_imports_season_code_key').on(table.seasonCode),
    check('season_imports_season_code_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check(
      'season_imports_status_valid',
      sql`status = ANY (ARRAY['unavailable'::text, 'pending'::text, 'building'::text, 'sealed'::text, 'failed'::text])`,
    ),
    check('season_imports_manifest_array', sql`jsonb_typeof(item_manifest) = 'array'::text`),
    check(
      'season_imports_completion_order',
      sql`(completed_at IS NULL) OR (started_at IS NULL) OR (completed_at >= started_at)`,
    ),
  ],
);

export const syncRunsInOps = ops.table(
  'sync_runs',
  {
    runId: uuid('run_id').primaryKey().notNull(),
    provider: text().notNull(),
    lane: text().notNull(),
    scope: text().notNull(),
    seasonId: smallint('season_id'),
    seasonCode: text('season_code'),
    eventId: integer('event_id'),
    mode: text().notNull(),
    trigger: text().notNull(),
    status: text().notNull(),
    expectedItems: integer('expected_items').default(0).notNull(),
    completedItems: integer('completed_items').default(0).notNull(),
    failedItems: integer('failed_items').default(0).notNull(),
    skippedItems: integer('skipped_items').default(0).notNull(),
    dataChanged: boolean('data_changed').default(false).notNull(),
    // This lazy reference breaks the sync_runs <-> dataset_publications declaration cycle.
    // Migration 0079 owns the stable database constraint name sync_runs_publication_fk.
    publicationId: uuid('publication_id').references(
      (): AnyPgColumn => datasetPublicationsInOps.publicationId,
    ),
    errorSummary: text('error_summary'),
    metadata: jsonb().default({}).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('sync_runs_provider_scope_started_idx').using(
      'btree',
      table.provider.asc().nullsLast(),
      table.scope.asc().nullsLast(),
      table.startedAt.desc().nullsFirst(),
    ),
    index('sync_runs_publication_fk_idx').using('btree', table.publicationId.asc().nullsLast()),
    index('sync_runs_season_event_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.eventId.asc().nullsLast())
      .where(sql`(season_id IS NOT NULL)`),
    index('sync_runs_season_fk_idx').using('btree', table.seasonId.asc().nullsLast()),
    index('sync_runs_status_started_idx').using(
      'btree',
      table.status.asc().nullsLast(),
      table.startedAt.desc().nullsFirst(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'sync_runs_season_fk',
    }),
    check('sync_runs_provider_nonempty', sql`btrim(provider) <> ''::text`),
    check('sync_runs_lane_nonempty', sql`btrim(lane) <> ''::text`),
    check('sync_runs_scope_nonempty', sql`btrim(scope) <> ''::text`),
    check('sync_runs_mode_nonempty', sql`btrim(mode) <> ''::text`),
    check('sync_runs_trigger_nonempty', sql`btrim(trigger) <> ''::text`),
    check(
      'sync_runs_status_valid',
      sql`status = ANY (ARRAY['pending'::text, 'running'::text, 'failed'::text, 'completed'::text, 'ready_to_publish'::text, 'published'::text, 'skipped'::text])`,
    ),
    check(
      'sync_runs_item_counts_nonnegative',
      sql`(expected_items >= 0) AND (completed_items >= 0) AND (failed_items >= 0) AND (skipped_items >= 0)`,
    ),
    check('sync_runs_event_positive', sql`(event_id IS NULL) OR (event_id > 0)`),
    check(
      'sync_runs_completion_order',
      sql`(completed_at IS NULL) OR (completed_at >= started_at)`,
    ),
    check('sync_runs_metadata_object', sql`jsonb_typeof(metadata) = 'object'::text`),
  ],
);

export const datasetPublicationsInOps = ops.table(
  'dataset_publications',
  {
    publicationId: uuid('publication_id').primaryKey().notNull(),
    dataset: text().notNull(),
    seasonId: smallint('season_id'),
    eventId: integer('event_id'),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    revision: bigint({ mode: 'number' })
      .default(sql`nextval('ops.dataset_publication_revisions'::regclass)`)
      .notNull(),
    status: text().default('staging').notNull(),
    manifest: jsonb().default({}).notNull(),
    sourceRunId: uuid('source_run_id'),
    activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'date' }),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('dataset_publications_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    // PostgreSQL migration 0079 also sets NULLS NOT DISTINCT. Drizzle ORM 0.43 cannot
    // express that option on a partial unique index, so the SQL migration remains authoritative.
    uniqueIndex('dataset_publications_one_active_scope_idx')
      .using(
        'btree',
        table.dataset.asc().nullsLast(),
        table.seasonId.asc().nullsLast(),
        table.eventId.asc().nullsLast(),
      )
      .where(sql`(status = 'active'::text)`),
    index('dataset_publications_season_fk_idx').using('btree', table.seasonId.asc().nullsLast()),
    index('dataset_publications_source_run_fk_idx').using(
      'btree',
      table.sourceRunId.asc().nullsLast(),
    ),
    index('dataset_publications_source_run_idx')
      .using('btree', table.sourceRunId.asc().nullsLast())
      .where(sql`(source_run_id IS NOT NULL)`),
    index('dataset_publications_status_created_idx').using(
      'btree',
      table.status.asc().nullsLast(),
      table.createdAt.desc().nullsFirst(),
    ),
    index('dataset_publications_expired_idx')
      .using('btree', table.expiresAt.asc().nullsLast())
      .where(
        sql`(expires_at IS NOT NULL) AND (status = ANY (ARRAY['retired'::text, 'failed'::text]))`,
      ),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'dataset_publications_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'dataset_publications_season_fk',
    }),
    foreignKey({
      columns: [table.sourceRunId],
      foreignColumns: [syncRunsInOps.runId],
      name: 'dataset_publications_source_run_fk',
    }),
    unique('dataset_publications_scope_unique')
      .on(table.dataset, table.seasonId, table.eventId, table.revision)
      .nullsNotDistinct(),
    check('dataset_publications_dataset_nonempty', sql`btrim(dataset) <> ''::text`),
    check(
      'dataset_publications_publication_id_rfc_uuid',
      sql`${table.publicationId}::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text`,
    ),
    check('dataset_publications_revision_positive', sql`revision > 0`),
    check('dataset_publications_event_positive', sql`(event_id IS NULL) OR (event_id > 0)`),
    check(
      'dataset_publications_status_valid',
      sql`status = ANY (ARRAY['staging'::text, 'active'::text, 'retired'::text, 'failed'::text])`,
    ),
    check(
      'dataset_publications_active_timestamp',
      sql`(status <> 'active'::text) OR (activated_at IS NOT NULL)`,
    ),
    check(
      'dataset_publications_retired_timestamp',
      sql`(status <> 'retired'::text) OR (retired_at IS NOT NULL)`,
    ),
    check('dataset_publications_manifest_object', sql`jsonb_typeof(manifest) = 'object'::text`),
  ],
);

export const datasetPublicationItemsInOps = ops.table(
  'dataset_publication_items',
  {
    publicationId: uuid('publication_id').notNull(),
    itemName: text('item_name').notNull(),
    payload: jsonb().notNull(),
    itemCount: integer('item_count').notNull(),
    checksum: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.publicationId, table.itemName] }),
    foreignKey({
      columns: [table.publicationId],
      foreignColumns: [datasetPublicationsInOps.publicationId],
      name: 'dataset_publication_items_publication_fk',
    }).onDelete('cascade'),
    index('dataset_publication_items_publication_idx').using(
      'btree',
      table.publicationId.asc().nullsLast(),
    ),
    check(
      'dataset_publication_items_name_valid',
      sql`item_name = ANY (ARRAY['eventLive'::text, 'fixtures'::text])`,
    ),
    check('dataset_publication_items_count_nonnegative', sql`item_count >= 0`),
    check('dataset_publication_items_checksum_nonempty', sql`btrim(checksum) <> ''::text`),
    check(
      'dataset_publication_items_payload_shape',
      sql`jsonb_typeof(payload) = ANY (ARRAY['array'::text, 'object'::text])`,
    ),
  ],
);

export const schemaMigrationsInOps = ops.table(
  'schema_migrations',
  {
    filename: text().primaryKey().notNull(),
    checksum: text().notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (_table) => [
    check('schema_migrations_filename_nonempty', sql`btrim(filename) <> ''::text`),
    check('schema_migrations_checksum_sha256', sql`checksum ~ '^[0-9a-f]{64}$'::text`),
  ],
);

export const bugReportsInOps = ops.table(
  'bug_reports',
  {
    id: uuid().primaryKey().notNull(),
    publicId: text('public_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    source: text().notNull(),
    userId: text('user_id'),
    entryId: integer('entry_id'),
    body: text().notNull(),
    screenshotUrl: text('screenshot_url'),
    clientMeta: jsonb('client_meta').default({}).notNull(),
    status: text().default('open').notNull(),
    submissionId: uuid('submission_id'),
    screenshotObjectKey: text('screenshot_object_key'),
    screenshotDeletedAt: timestamp('screenshot_deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('bug_reports_public_id_key').on(table.publicId),
    uniqueIndex('bug_reports_submission_id_key').on(table.submissionId),
    index('bug_reports_created_idx').on(table.createdAt.desc()),
    index('bug_reports_screenshot_retention_idx')
      .on(table.createdAt.asc())
      .where(sql`screenshot_object_key IS NOT NULL AND screenshot_deleted_at IS NULL`),
    index('bug_reports_user_created_idx')
      .on(table.userId, table.createdAt.desc())
      .where(sql`user_id IS NOT NULL`),
    check('bug_reports_public_id_format', sql`public_id ~ '^LL-[0-9A-F]{6}$'::text`),
    check(
      'bug_reports_source_known',
      sql`source = ANY (ARRAY['website'::text, 'wechat_miniprogram'::text])`,
    ),
    check(
      'bug_reports_status_known',
      sql`status = ANY (ARRAY['open'::text, 'ack'::text, 'closed'::text])`,
    ),
    check(
      'bug_reports_body_nonempty',
      sql`(char_length(btrim(body)) >= 8) AND (char_length(body) <= 500)`,
    ),
    check('bug_reports_entry_id_positive', sql`(entry_id IS NULL) OR (entry_id > 0)`),
    check(
      'bug_reports_screenshot_input_exclusive',
      sql`NOT (screenshot_url IS NOT NULL AND screenshot_object_key IS NOT NULL)`,
    ),
    check(
      'bug_reports_screenshot_object_key_format',
      sql`(screenshot_object_key IS NULL) OR ((submission_id IS NOT NULL) AND COALESCE(substring(lower(screenshot_object_key) FROM '^bug-reports/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.(jpg|png|webp|gif)$'::text) = lower(submission_id::text), false))`,
    ),
    check(
      'bug_reports_screenshot_https',
      sql`(screenshot_url IS NULL) OR (screenshot_url ~ '^https://'::text)`,
    ),
  ],
);

export const seasonsInFpl = fpl.table(
  'seasons',
  {
    seasonId: smallint('season_id').primaryKey().notNull(),
    seasonCode: text('season_code').notNull(),
    displayName: text('display_name').notNull(),
    startYear: smallint('start_year').notNull(),
    endYear: smallint('end_year').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    isCurrent: boolean('is_current').default(false).notNull(),
    startsAt: date('starts_at'),
    endsAt: date('ends_at'),
    sourceMetadata: jsonb('source_metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('seasons_one_current_idx')
      .using('btree', table.isCurrent.asc().nullsLast())
      .where(sql`is_current`),
    unique('seasons_season_code_key').on(table.seasonCode),
    unique('seasons_display_name_key').on(table.displayName),
    unique('seasons_start_year_key').on(table.startYear),
    unique('seasons_end_year_key').on(table.endYear),
    check('seasons_id_is_start_year', sql`season_id = start_year`),
    check('seasons_code_format', sql`season_code ~ '^[0-9]{4}$'::text`),
    check('seasons_year_span', sql`end_year = (start_year + 1)`),
    check(
      'seasons_lifecycle_state_valid',
      sql`lifecycle_state = ANY (ARRAY['reference_only'::text, 'completed'::text, 'preseason'::text, 'active'::text, 'closed'::text])`,
    ),
    check(
      'seasons_date_order',
      sql`(ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at)`,
    ),
    check('seasons_source_metadata_object', sql`jsonb_typeof(source_metadata) = 'object'::text`),
  ],
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

export const phasesInFpl = fpl.table(
  'phases',
  {
    seasonId: smallint('season_id').notNull(),
    phaseId: integer('phase_id').notNull(),
    name: text().notNull(),
    startEvent: integer('start_event').notNull(),
    stopEvent: integer('stop_event').notNull(),
    highestScore: integer('highest_score'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('phases_event_range_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.startEvent.asc().nullsLast(),
      table.stopEvent.asc().nullsLast(),
    ),
    index('phases_stop_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.stopEvent.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'phases_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.startEvent],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'phases_start_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.stopEvent],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'phases_stop_event_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.phaseId], name: 'phases_pkey' }),
    check('phases_phase_id_positive', sql`phase_id > 0`),
    check('phases_event_range', sql`(start_event > 0) AND (stop_event >= start_event)`),
    check('phases_highest_score_nonnegative', sql`(highest_score IS NULL) OR (highest_score >= 0)`),
    check('phases_name_nonempty', sql`btrim(name) <> ''::text`),
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

export const playerGameweekScoringItemsInFpl = fpl.table(
  'player_gameweek_scoring_items',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    elementId: integer('element_id').notNull(),
    scoringIdentifier: text('scoring_identifier').notNull(),
    scoringValue: integer('scoring_value').notNull(),
    points: integer().notNull(),
    sourceExplainId: integer('source_explain_id')
      .generatedByDefaultAsIdentity({
        name: 'player_gameweek_scoring_items_source_explain_id_seq',
      })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('player_gameweek_scoring_items_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('player_gameweek_scoring_items_source_id_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceExplainId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_gameweek_scoring_items_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId, table.elementId],
      foreignColumns: [
        playerGameweekStatsInFpl.seasonId,
        playerGameweekStatsInFpl.eventId,
        playerGameweekStatsInFpl.elementId,
      ],
      name: 'player_scoring_gameweek_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.elementId, table.scoringIdentifier],
      name: 'player_gameweek_scoring_items_pkey',
    }),
    check(
      'player_gameweek_scoring_items_ids_positive',
      sql`(event_id > 0) AND (element_id > 0) AND (source_explain_id > 0)`,
    ),
    check(
      'player_gameweek_scoring_items_identifier_valid',
      sql`scoring_identifier = ANY (ARRAY['minutes'::text, 'goals_scored'::text, 'assists'::text, 'clean_sheets'::text, 'goals_conceded'::text, 'own_goals'::text, 'penalties_saved'::text, 'penalties_missed'::text, 'yellow_cards'::text, 'red_cards'::text, 'saves'::text, 'bonus'::text, 'defensive_contribution'::text])`,
    ),
  ],
);

export const syncItemsInOps = ops.table(
  'sync_items',
  {
    runId: uuid('run_id').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    status: text().default('pending').notNull(),
    attempts: integer().default(0).notNull(),
    sourceHash: text('source_hash'),
    normalizedPayload: jsonb('normalized_payload'),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('sync_items_status_idx').using(
      'btree',
      table.status.asc().nullsLast(),
      table.runId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.runId],
      foreignColumns: [syncRunsInOps.runId],
      name: 'sync_items_run_fk',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.runId, table.resourceType, table.resourceId],
      name: 'sync_items_pkey',
    }),
    check(
      'sync_items_status_valid',
      sql`status = ANY (ARRAY['pending'::text, 'running'::text, 'failed'::text, 'completed'::text, 'skipped'::text])`,
    ),
    check('sync_items_resource_type_nonempty', sql`btrim(resource_type) <> ''::text`),
    check('sync_items_resource_id_nonempty', sql`btrim(resource_id) <> ''::text`),
    check('sync_items_attempts_nonnegative', sql`attempts >= 0`),
    check(
      'sync_items_payload_object',
      sql`(normalized_payload IS NULL) OR (jsonb_typeof(normalized_payload) = 'object'::text)`,
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
      'entry_leagues_started_event_positive',
      sql`(started_event IS NULL) OR (started_event > 0)`,
    ),
  ],
);

export const playersInFpl = fpl.table(
  'players',
  {
    seasonId: smallint('season_id').notNull(),
    elementId: integer('element_id').notNull(),
    code: integer().notNull(),
    elementType: integer('element_type').notNull(),
    teamId: integer('team_id').notNull(),
    price: integer().default(0).notNull(),
    startPrice: integer('start_price').default(0).notNull(),
    firstName: text('first_name'),
    secondName: text('second_name'),
    webName: text('web_name').notNull(),
    totalPoints: integer('total_points').default(0).notNull(),
    priceSourceCheckedAt: timestamp('price_source_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('players_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamId.asc().nullsLast(),
    ),
    index('players_type_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementType.asc().nullsLast(),
    ),
    index('players_web_name_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.webName.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'players_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'players_team_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.elementId], name: 'players_pkey' }),
    unique('players_season_code_unique').on(table.seasonId, table.code),
    check('players_element_id_positive', sql`element_id > 0`),
    check('players_code_positive', sql`code > 0`),
    check('players_element_type_positive', sql`element_type > 0`),
    check('players_prices_nonnegative', sql`(price >= 0) AND (start_price >= 0)`),
    check('players_web_name_nonempty', sql`btrim(web_name) <> ''::text`),
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

export const playerFixtureStatsInFpl = fpl.table(
  'player_fixture_stats',
  {
    seasonId: smallint('season_id').notNull(),
    fixtureId: integer('fixture_id').notNull(),
    elementId: integer('element_id').notNull(),
    sourceFixtureStatId: integer('source_fixture_stat_id')
      .generatedByDefaultAsIdentity({ name: 'player_fixture_stats_source_fixture_stat_id_seq' })
      .notNull(),
    eventId: integer('event_id').notNull(),
    fixtureCode: integer('fixture_code').notNull(),
    playerCode: integer('player_code').notNull(),
    teamId: integer('team_id').notNull(),
    teamCode: integer('team_code').notNull(),
    elementType: integer('element_type').notNull(),
    minutes: integer().notNull(),
    starts: integer(),
    goals: integer().notNull(),
    assists: integer().notNull(),
    ownGoals: integer('own_goals').notNull(),
    yellowCards: integer('yellow_cards').notNull(),
    redCards: integer('red_cards').notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('player_fixture_stats_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('player_fixture_stats_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    uniqueIndex('player_fixture_stats_source_id_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceFixtureStatId.asc().nullsLast(),
    ),
    index('player_fixture_stats_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_fixture_stats_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'player_fixture_stats_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.fixtureId],
      foreignColumns: [fixturesInFpl.seasonId, fixturesInFpl.fixtureId],
      name: 'player_fixture_stats_fixture_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_fixture_stats_player_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'player_fixture_stats_team_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.fixtureId, table.elementId],
      name: 'player_fixture_stats_pkey',
    }),
    check(
      'player_fixture_stats_counts_nonnegative',
      sql`(minutes >= 0) AND ((starts IS NULL) OR (starts >= 0)) AND (goals >= 0) AND (assists >= 0) AND (own_goals >= 0) AND (yellow_cards >= 0) AND (red_cards >= 0)`,
    ),
    check(
      'player_fixture_stats_ids_positive',
      sql`(fixture_id > 0) AND (element_id > 0) AND (source_fixture_stat_id > 0) AND (event_id > 0) AND (fixture_code > 0) AND (player_code > 0) AND (team_id > 0) AND (team_code > 0) AND (element_type > 0)`,
    ),
    check('player_fixture_stats_source_hash_nonempty', sql`btrim(source_hash) <> ''::text`),
  ],
);

export const fixturesInFpl = fpl.table(
  'fixtures',
  {
    seasonId: smallint('season_id').notNull(),
    fixtureId: integer('fixture_id').notNull(),
    code: integer().notNull(),
    eventId: integer('event_id'),
    kickoffTime: timestamp('kickoff_time', { withTimezone: true, mode: 'date' }),
    started: boolean().default(false).notNull(),
    finished: boolean().default(false).notNull(),
    finishedProvisional: boolean('finished_provisional').default(false).notNull(),
    provisionalStartTime: boolean('provisional_start_time').default(false).notNull(),
    minutes: integer().default(0).notNull(),
    teamHId: integer('team_h_id'),
    teamHDifficulty: integer('team_h_difficulty'),
    teamHScore: integer('team_h_score'),
    teamAId: integer('team_a_id'),
    teamADifficulty: integer('team_a_difficulty'),
    teamAScore: integer('team_a_score'),
    stats: jsonb().default([]).notNull(),
    pulseId: integer('pulse_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('fixtures_away_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamAId.asc().nullsLast(),
    ),
    index('fixtures_event_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    index('fixtures_home_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamHId.asc().nullsLast(),
    ),
    index('fixtures_kickoff_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.kickoffTime.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'fixtures_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamAId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'fixtures_away_team_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'fixtures_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamHId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'fixtures_home_team_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.fixtureId], name: 'fixtures_pkey' }),
    unique('fixtures_season_code_unique').on(table.seasonId, table.code),
    check('fixtures_fixture_id_positive', sql`fixture_id > 0`),
    check('fixtures_code_positive', sql`code > 0`),
    check('fixtures_event_positive', sql`(event_id IS NULL) OR (event_id > 0)`),
    check('fixtures_minutes_valid', sql`(minutes >= 0) AND (minutes <= 180)`),
    check(
      'fixtures_distinct_teams',
      sql`(team_h_id IS NULL) OR (team_a_id IS NULL) OR (team_h_id <> team_a_id)`,
    ),
    check(
      'fixtures_scores_nonnegative',
      sql`((team_h_score IS NULL) OR (team_h_score >= 0)) AND ((team_a_score IS NULL) OR (team_a_score >= 0))`,
    ),
    check(
      'fixtures_difficulty_valid',
      sql`((team_h_difficulty IS NULL) OR ((team_h_difficulty >= 0) AND (team_h_difficulty <= 5))) AND ((team_a_difficulty IS NULL) OR ((team_a_difficulty >= 0) AND (team_a_difficulty <= 5)))`,
    ),
    check('fixtures_stats_array', sql`jsonb_typeof(stats) = 'array'::text`),
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
  ],
);

export const teamsInFpl = fpl.table(
  'teams',
  {
    seasonId: smallint('season_id').notNull(),
    teamId: integer('team_id').notNull(),
    code: integer().notNull(),
    name: text().notNull(),
    shortName: text('short_name').notNull(),
    strength: integer(),
    position: integer().default(0).notNull(),
    points: integer().default(0).notNull(),
    win: integer().default(0).notNull(),
    draw: integer().default(0).notNull(),
    loss: integer().default(0).notNull(),
    played: integer().default(0).notNull(),
    form: text(),
    teamDivision: integer('team_division'),
    unavailable: boolean().default(false).notNull(),
    strengthOverallHome: integer('strength_overall_home').default(1000).notNull(),
    strengthOverallAway: integer('strength_overall_away').default(1000).notNull(),
    strengthAttackHome: integer('strength_attack_home').default(1000).notNull(),
    strengthAttackAway: integer('strength_attack_away').default(1000).notNull(),
    strengthDefenceHome: integer('strength_defence_home').default(1000).notNull(),
    strengthDefenceAway: integer('strength_defence_away').default(1000).notNull(),
    pulseId: integer('pulse_id').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('teams_season_name_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.name.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'teams_season_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.teamId], name: 'teams_pkey' }),
    unique('teams_season_code_unique').on(table.seasonId, table.code),
    check('teams_team_id_positive', sql`team_id > 0`),
    check('teams_code_positive', sql`code > 0`),
    check(
      'teams_record_nonnegative',
      sql`("position" >= 0) AND (win >= 0) AND (draw >= 0) AND (loss >= 0) AND (played >= 0)`,
    ),
    check(
      'teams_names_nonempty',
      sql`(btrim(name) <> ''::text) AND (btrim(short_name) <> ''::text)`,
    ),
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

export const playerGameweekStatsInFpl = fpl.table(
  'player_gameweek_stats',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    elementId: integer('element_id').notNull(),
    sourceLiveId: integer('source_live_id')
      .generatedByDefaultAsIdentity({ name: 'player_gameweek_stats_source_live_id_seq' })
      .notNull(),
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
    starts: boolean(),
    expectedGoals: numeric('expected_goals'),
    expectedAssists: numeric('expected_assists'),
    expectedGoalInvolvements: numeric('expected_goal_involvements'),
    expectedGoalsConceded: numeric('expected_goals_conceded'),
    inDreamTeam: boolean('in_dream_team'),
    totalPoints: integer('total_points').default(0).notNull(),
    defensiveContribution: integer('defensive_contribution').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('player_gameweek_stats_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    uniqueIndex('player_gameweek_stats_source_id_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceLiveId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_gameweek_stats_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'player_gameweek_stats_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_gameweek_stats_player_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.elementId],
      name: 'player_gameweek_stats_pkey',
    }),
    check(
      'player_gameweek_stats_ids_positive',
      sql`(event_id > 0) AND (element_id > 0) AND (source_live_id > 0)`,
    ),
    check('player_gameweek_stats_minutes_nonnegative', sql`(minutes IS NULL) OR (minutes >= 0)`),
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

export const eventsInFpl = fpl.table(
  'events',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    name: text().notNull(),
    deadlineTime: timestamp('deadline_time', { withTimezone: true, mode: 'string' }),
    averageEntryScore: integer('average_entry_score'),
    finished: boolean().default(false).notNull(),
    dataChecked: boolean('data_checked').default(false).notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    highestScoringEntry: bigint('highest_scoring_entry', { mode: 'number' }),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    deadlineTimeEpoch: bigint('deadline_time_epoch', { mode: 'number' }),
    deadlineTimeGameOffset: integer('deadline_time_game_offset'),
    highestScore: integer('highest_score'),
    isPrevious: boolean('is_previous').default(false).notNull(),
    isCurrent: boolean('is_current').default(false).notNull(),
    isNext: boolean('is_next').default(false).notNull(),
    cupLeagueCreate: boolean('cup_league_create').default(false).notNull(),
    h2HKoMatchesCreated: boolean('h2h_ko_matches_created').default(false).notNull(),
    chipPlays: jsonb('chip_plays').default([]).notNull(),
    mostSelected: integer('most_selected'),
    mostTransferredIn: integer('most_transferred_in'),
    topElement: integer('top_element'),
    topElementInfo: jsonb('top_element_info'),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    transfersMade: bigint('transfers_made', { mode: 'number' }),
    mostCaptained: integer('most_captained'),
    mostViceCaptained: integer('most_vice_captained'),
    liveSnapshotCheckedAt: timestamp('live_snapshot_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    liveSnapshotFinalizedAt: timestamp('live_snapshot_finalized_at', {
      withTimezone: true,
      mode: 'date',
    }),
    dataCheckedAt: timestamp('data_checked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    liveFactsPersistedAt: timestamp('live_facts_persisted_at', {
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    index('events_current_flags_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.isCurrent.asc().nullsLast(),
      table.isNext.asc().nullsLast(),
      table.isPrevious.asc().nullsLast(),
    ),
    index('events_deadline_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.deadlineTime.asc().nullsLast(),
    ),
    index('events_most_captained_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.mostCaptained.asc().nullsLast(),
    ),
    index('events_most_selected_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.mostSelected.asc().nullsLast(),
    ),
    index('events_most_transferred_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.mostTransferredIn.asc().nullsLast(),
    ),
    index('events_most_vice_captained_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.mostViceCaptained.asc().nullsLast(),
    ),
    index('events_top_element_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.topElement.asc().nullsLast(),
    ),
    index('events_top_element_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.topElement.asc().nullsLast())
      .where(sql`(top_element IS NOT NULL)`),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'events_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.mostCaptained],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_most_captained_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.mostSelected],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_most_selected_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.mostTransferredIn],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_most_transferred_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.mostViceCaptained],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_most_vice_captained_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.topElement],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'events_top_element_fk',
    }),
    primaryKey({ columns: [table.seasonId, table.eventId], name: 'events_pkey' }),
    check('events_event_id_positive', sql`event_id > 0`),
    check(
      'events_scores_nonnegative',
      sql`((average_entry_score IS NULL) OR (average_entry_score >= 0)) AND ((highest_score IS NULL) OR (highest_score >= 0))`,
    ),
    check('events_chip_plays_array', sql`jsonb_typeof(chip_plays) = 'array'::text`),
    check(
      'events_finalization_order',
      sql`(live_snapshot_finalized_at IS NULL) OR (live_snapshot_checked_at IS NULL) OR (live_snapshot_finalized_at >= live_snapshot_checked_at)`,
    ),
  ],
);

export const playerMarketSnapshotsInFpl = fpl.table(
  'player_market_snapshots',
  {
    seasonId: smallint('season_id').notNull(),
    snapshotDate: date('snapshot_date').notNull(),
    elementId: integer('element_id').notNull(),
    sourceSnapshotId: integer('source_snapshot_id').default(
      sql`nextval('fpl.player_market_snapshots_source_snapshot_id_seq'::regclass)`,
    ),
    snapshotSource: text('snapshot_source').default('upstream').notNull(),
    sourceValueId: integer('source_value_id'),
    sourceEventId: integer('source_event_id'),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).notNull(),
    playerCode: integer('player_code').notNull(),
    webName: text('web_name').notNull(),
    firstName: text('first_name').notNull(),
    secondName: text('second_name').notNull(),
    teamId: integer('team_id').notNull(),
    teamName: text('team_name').notNull(),
    teamShortName: text('team_short_name').notNull(),
    elementType: integer('element_type').notNull(),
    position: text().notNull(),
    price: integer().notNull(),
    selectedByPercent: numeric('selected_by_percent').notNull(),
    transfersIn: integer('transfers_in').notNull(),
    transfersOut: integer('transfers_out').notNull(),
    transfersInEvent: integer('transfers_in_event').notNull(),
    transfersOutEvent: integer('transfers_out_event').notNull(),
    status: text().notNull(),
    news: text().notNull(),
    newsAdded: timestamp('news_added', { withTimezone: true, mode: 'date' }),
    chanceOfPlayingThisRound: integer('chance_of_playing_this_round'),
    chanceOfPlayingNextRound: integer('chance_of_playing_next_round'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('player_market_snapshots_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceEventId.asc().nullsLast(),
    ),
    index('player_market_snapshots_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.snapshotDate.asc().nullsLast(),
    ),
    uniqueIndex('player_market_snapshots_source_id_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.sourceSnapshotId.asc().nullsLast())
      .where(sql`(source_snapshot_id IS NOT NULL)`),
    uniqueIndex('player_market_snapshots_source_value_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.sourceValueId.asc().nullsLast())
      .where(sql`(source_value_id IS NOT NULL)`),
    index('player_market_snapshots_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamId.asc().nullsLast(),
      table.snapshotDate.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_market_snapshots_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.sourceEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'player_market_snapshots_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_market_snapshots_player_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'player_market_snapshots_team_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.snapshotDate, table.elementId],
      name: 'player_market_snapshots_pkey',
    }),
    check(
      'player_market_snapshots_ids_positive',
      sql`(element_id > 0) AND (player_code > 0) AND (team_id > 0) AND (element_type > 0) AND ((source_snapshot_id IS NULL) OR (source_snapshot_id > 0)) AND ((source_value_id IS NULL) OR (source_value_id > 0)) AND ((source_event_id IS NULL) OR (source_event_id > 0))`,
    ),
    check(
      'player_market_snapshots_source_valid',
      sql`((snapshot_source = 'upstream'::text) AND (source_snapshot_id IS NOT NULL) AND (source_value_id IS NULL)) OR ((snapshot_source = 'value_seed'::text) AND (source_snapshot_id IS NULL) AND (source_value_id IS NOT NULL) AND (source_event_id IS NOT NULL))`,
    ),
    check('player_market_snapshots_price_nonnegative', sql`price >= 0`),
    check(
      'player_market_snapshots_selected_percent',
      sql`(selected_by_percent >= (0)::numeric) AND (selected_by_percent <= (100)::numeric)`,
    ),
    check(
      'player_market_snapshots_transfers_nonnegative',
      sql`(transfers_in >= 0) AND (transfers_out >= 0) AND (transfers_in_event >= 0) AND (transfers_out_event >= 0)`,
    ),
    check(
      'player_market_snapshots_chance_valid',
      sql`((chance_of_playing_this_round IS NULL) OR ((chance_of_playing_this_round >= 0) AND (chance_of_playing_this_round <= 100))) AND ((chance_of_playing_next_round IS NULL) OR ((chance_of_playing_next_round >= 0) AND (chance_of_playing_next_round <= 100)))`,
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
  ],
);

export const playerEventSnapshotsInFpl = fpl.table(
  'player_event_snapshots',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    elementId: integer('element_id').notNull(),
    sourceSnapshotId: integer('source_snapshot_id')
      .generatedByDefaultAsIdentity({ name: 'player_event_snapshots_source_snapshot_id_seq' })
      .notNull(),
    elementType: integer('element_type').notNull(),
    totalPoints: integer('total_points'),
    form: numeric(),
    influence: numeric(),
    creativity: numeric(),
    threat: numeric(),
    ictIndex: numeric('ict_index'),
    expectedGoals: numeric('expected_goals'),
    expectedAssists: numeric('expected_assists'),
    expectedGoalInvolvements: numeric('expected_goal_involvements'),
    expectedGoalsConceded: numeric('expected_goals_conceded'),
    minutes: integer(),
    goalsScored: integer('goals_scored'),
    assists: integer(),
    cleanSheets: integer('clean_sheets'),
    goalsConceded: integer('goals_conceded'),
    ownGoals: integer('own_goals'),
    penaltiesSaved: integer('penalties_saved'),
    yellowCards: integer('yellow_cards'),
    redCards: integer('red_cards'),
    saves: integer(),
    bonus: integer(),
    bps: integer(),
    starts: integer(),
    influenceRank: integer('influence_rank'),
    influenceRankType: integer('influence_rank_type'),
    creativityRank: integer('creativity_rank'),
    creativityRankType: integer('creativity_rank_type'),
    threatRank: integer('threat_rank'),
    threatRankType: integer('threat_rank_type'),
    ictIndexRank: integer('ict_index_rank'),
    ictIndexRankType: integer('ict_index_rank_type'),
    transfersIn: integer('transfers_in'),
    transfersInEvent: integer('transfers_in_event'),
    transfersOut: integer('transfers_out'),
    transfersOutEvent: integer('transfers_out_event'),
    selectedByPercent: numeric('selected_by_percent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('player_event_snapshots_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.eventId.asc().nullsLast(),
    ),
    uniqueIndex('player_event_snapshots_source_id_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceSnapshotId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_event_snapshots_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'player_event_snapshots_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_event_snapshots_player_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.eventId, table.elementId],
      name: 'player_event_snapshots_pkey',
    }),
    check(
      'player_event_snapshots_ids_positive',
      sql`(event_id > 0) AND (element_id > 0) AND (source_snapshot_id > 0) AND (element_type > 0)`,
    ),
    check('player_event_snapshots_minutes_nonnegative', sql`(minutes IS NULL) OR (minutes >= 0)`),
    check(
      'player_event_snapshots_selected_percent',
      sql`(selected_by_percent IS NULL) OR ((selected_by_percent >= (0)::numeric) AND (selected_by_percent <= (100)::numeric))`,
    ),
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
    sql`WITH expected_entries AS ( SELECT tournament_entries.tournament_id, tournament_entries.season_id, count(*)::integer AS total_entries FROM competition.tournament_entries GROUP BY tournament_entries.tournament_id, tournament_entries.season_id ), valid_entry_events AS ( SELECT entry.tournament_id, entry.season_id, pick.event_id, entry.entry_id FROM competition.tournament_entries entry JOIN competition.entry_event_picks pick ON pick.season_id = entry.season_id AND pick.entry_id = entry.entry_id GROUP BY entry.tournament_id, entry.season_id, pick.event_id, entry.entry_id HAVING count(*) = 15 AND min(pick."position") = 1 AND max(pick."position") = 15 AND count(*) FILTER (WHERE pick.is_captain) = 1 AND count(*) FILTER (WHERE pick.is_vice_captain) = 1 ), complete_scopes AS ( SELECT valid.tournament_id, valid.season_id, valid.event_id, expected.total_entries FROM valid_entry_events valid JOIN expected_entries expected ON expected.tournament_id = valid.tournament_id AND expected.season_id = valid.season_id GROUP BY valid.tournament_id, valid.season_id, valid.event_id, expected.total_entries HAVING expected.total_entries > 0 AND count(*) = expected.total_entries ), pick_aggregates AS ( SELECT entry.tournament_id, pick.season_id, pick.event_id, pick.entry_id, count(*)::integer AS pick_count, sum(pick.multiplier * COALESCE(stats.total_points, 0))::integer AS selection_points, sum( CASE WHEN pick.multiplier = 0 THEN COALESCE(stats.total_points, 0) ELSE 0 END)::integer AS calculated_bench_points, sum( CASE WHEN player.element_type = 1 THEN pick.multiplier * COALESCE(stats.total_points, 0) ELSE 0 END)::integer AS goalkeeper_points, sum( CASE WHEN player.element_type = 2 THEN pick.multiplier * COALESCE(stats.total_points, 0) ELSE 0 END)::integer AS defender_points, sum( CASE WHEN player.element_type = 3 THEN pick.multiplier * COALESCE(stats.total_points, 0) ELSE 0 END)::integer AS midfielder_points, sum( CASE WHEN player.element_type = 4 THEN pick.multiplier * COALESCE(stats.total_points, 0) ELSE 0 END)::integer AS forward_points, max(pick.element_id) FILTER (WHERE pick.is_captain) AS captain_element_id, max(pick.element_id) FILTER (WHERE pick.is_vice_captain) AS vice_captain_element_id FROM competition.tournament_entries entry JOIN competition.entry_event_picks pick ON pick.season_id = entry.season_id AND pick.entry_id = entry.entry_id JOIN fpl.players player ON player.season_id = pick.season_id AND player.element_id = pick.element_id LEFT JOIN fpl.player_gameweek_stats stats ON stats.season_id = pick.season_id AND stats.event_id = pick.event_id AND stats.element_id = pick.element_id GROUP BY entry.tournament_id, pick.season_id, pick.event_id, pick.entry_id ), transfer_aggregates AS ( SELECT entry.tournament_id, transfer.season_id, transfer.event_id, transfer.entry_id, count(*)::integer AS transfer_count FROM competition.tournament_entries entry JOIN competition.entry_event_transfers transfer ON transfer.season_id = entry.season_id AND transfer.entry_id = entry.entry_id GROUP BY entry.tournament_id, transfer.season_id, transfer.event_id, transfer.entry_id ), base AS ( SELECT entry.tournament_id, result.season_id, result.event_id, result.entry_id, scope.total_entries, result.event_points, result.event_transfers, result.event_transfers_cost, result.event_net_points, result.event_bench_points, result.event_auto_sub_points, result.event_rank, result.event_chip, result.played_captain_element_id, result.captain_points, result.overall_points, result.overall_rank, result.team_value, result.bank, pick.pick_count, pick.selection_points, pick.calculated_bench_points, pick.goalkeeper_points, pick.defender_points, pick.midfielder_points, pick.forward_points, pick.captain_element_id, pick.vice_captain_element_id, COALESCE(transfer.transfer_count, 0) AS transfer_row_count, event.live_snapshot_finalized_at AS source_finalized_at FROM complete_scopes scope JOIN competition.tournament_entries entry ON entry.tournament_id = scope.tournament_id AND entry.season_id = scope.season_id JOIN competition.entry_event_results result ON result.season_id = entry.season_id AND result.entry_id = entry.entry_id AND result.event_id = scope.event_id AND result.rich_synced_at IS NOT NULL JOIN fpl.events event ON event.season_id = result.season_id AND event.event_id = result.event_id AND event.finished AND event.data_checked AND event.live_snapshot_finalized_at IS NOT NULL JOIN pick_aggregates pick ON pick.tournament_id = entry.tournament_id AND pick.season_id = result.season_id AND pick.event_id = result.event_id AND pick.entry_id = result.entry_id LEFT JOIN transfer_aggregates transfer ON transfer.tournament_id = entry.tournament_id AND transfer.season_id = result.season_id AND transfer.event_id = result.event_id AND transfer.entry_id = result.entry_id ) SELECT base.tournament_id, base.season_id, base.event_id, base.entry_id, base.total_entries, base.event_points, base.event_transfers, base.event_transfers_cost, base.event_net_points, base.event_bench_points, base.event_auto_sub_points, base.event_rank, base.event_chip, base.played_captain_element_id, base.captain_points, base.overall_points, base.overall_rank, base.team_value, base.bank, base.pick_count, base.selection_points, base.calculated_bench_points, base.goalkeeper_points, base.defender_points, base.midfielder_points, base.forward_points, base.captain_element_id, base.vice_captain_element_id, base.transfer_row_count, base.source_finalized_at, rank() OVER (PARTITION BY base.tournament_id, base.event_id ORDER BY base.event_net_points DESC, base.entry_id) AS tournament_event_rank, sum(base.event_net_points) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::integer AS cumulative_net_points, sum(base.event_transfers) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::integer AS cumulative_transfers, sum(base.event_transfers_cost) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::integer AS cumulative_transfer_cost, sum(COALESCE(base.event_bench_points, 0)) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::integer AS cumulative_bench_points, sum(COALESCE(base.event_auto_sub_points, 0)) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::integer AS cumulative_auto_sub_points, sum(COALESCE(base.captain_points, 0)) OVER (PARTITION BY base.tournament_id, base.entry_id ORDER BY base.event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::integer AS cumulative_captain_points FROM base`,
  );
