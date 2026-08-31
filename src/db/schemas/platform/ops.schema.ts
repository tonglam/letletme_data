// Canonical ops PostgreSQL schema declarations.
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
  numeric,
  doublePrecision,
  primaryKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ops } from './namespaces.schema';
import { seasonsInFpl, eventsInFpl } from './fpl.schema';

export const datasetPublicationRevisionsInOps = ops.sequence('dataset_publication_revisions', {
  startWith: '1',
  increment: '1',
  minValue: '1',
  maxValue: '9223372036854775807',
  cache: '1',
  cycle: false,
});

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
    // Migration 0080 owns the stable database constraint name sync_runs_publication_fk.
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
    // PostgreSQL migration 0080 also sets NULLS NOT DISTINCT. Drizzle ORM 0.43 cannot
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
      sql`item_name = ANY (ARRAY['context'::text, 'events'::text, 'teams'::text, 'players'::text, 'phases'::text, 'fixtures'::text, 'currentEventId'::text, 'selectionRules'::text, 'eventLive'::text])`,
    ),
    check('dataset_publication_items_count_nonnegative', sql`item_count >= 0`),
    check('dataset_publication_items_checksum_nonempty', sql`btrim(checksum) <> ''::text`),
    check(
      'dataset_publication_items_payload_shape',
      sql`jsonb_typeof(payload) = ANY (ARRAY['array'::text, 'object'::text, 'number'::text, 'null'::text, 'boolean'::text, 'string'::text])`,
    ),
  ],
);

export const dataPublicationOutboxInOps = ops.table(
  'data_publication_outbox',
  {
    outboxId: uuid('outbox_id').primaryKey().notNull(),
    publicationId: uuid('publication_id').notNull(),
    sourceRunId: uuid('source_run_id'),
    dataset: text().notNull(),
    seasonId: smallint('season_id'),
    eventId: integer('event_id'),
    manifest: jsonb().notNull(),
    status: text().default('pending').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    attempts: integer().default(0).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    stagedAt: timestamp('staged_at', { withTimezone: true, mode: 'date' }),
    dbActivatedAt: timestamp('db_activated_at', { withTimezone: true, mode: 'date' }),
    redisActivatedAt: timestamp('redis_activated_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('data_publication_outbox_publication_key').on(table.publicationId),
    index('data_publication_outbox_pending_idx')
      .on(table.availableAt, table.outboxId)
      .where(
        sql`status IN ('pending', 'staged', 'db_activated', 'redis_activated') AND delivered_at IS NULL`,
      ),
    index('data_publication_outbox_reclaim_idx')
      .on(table.leaseExpiresAt, table.outboxId)
      .where(sql`delivered_at IS NULL AND lease_expires_at IS NOT NULL`),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'data_publication_outbox_season_fk',
    }),
    foreignKey({
      columns: [table.publicationId],
      foreignColumns: [datasetPublicationsInOps.publicationId],
      name: 'data_publication_outbox_publication_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.sourceRunId],
      foreignColumns: [syncRunsInOps.runId],
      name: 'data_publication_outbox_source_run_id_fkey',
    }).onDelete('restrict'),
    check(
      'data_publication_outbox_dataset_check',
      sql`dataset = ANY (ARRAY['fpl:core'::text, 'fpl:market'::text, 'fpl:price-changes'::text])`,
    ),
    check(
      'data_publication_outbox_status_check',
      sql`status = ANY (ARRAY['pending'::text, 'staged'::text, 'db_activated'::text, 'redis_activated'::text, 'delivered'::text, 'failed'::text])`,
    ),
    check('data_publication_outbox_attempts_check', sql`attempts >= 0`),
    check(
      'data_publication_outbox_manifest_object_check',
      sql`jsonb_typeof(manifest) = 'object'::text`,
    ),
    check('data_publication_outbox_event_check', sql`(event_id IS NULL) OR (event_id > 0)`),
    check(
      'data_publication_outbox_lease_check',
      sql`(lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)`,
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

export const mutationScopesInOps = ops.table(
  'mutation_scopes',
  {
    scopeKey: text('scope_key').primaryKey().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (_table) => [check('mutation_scopes_key_nonempty', sql`btrim(scope_key) <> ''::text`)],
);

export const schedulerObligationsInOps = ops.table(
  'scheduler_obligations',
  {
    obligationId: uuid('obligation_id').primaryKey().notNull(),
    jobName: text('job_name').notNull(),
    scopeKey: text('scope_key').notNull(),
    periodKey: text('period_key').notNull(),
    cadence: text().notNull(),
    timezone: text().notNull(),
    status: text().default('pending').notNull(),
    source: text().default('schedule').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
    generation: integer().default(0).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    bullJobId: text('bull_job_id'),
    runId: uuid('run_id'),
    attempts: integer().default(0).notNull(),
    lastError: text('last_error'),
    evidence: jsonb().default({}).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('scheduler_obligations_identity_key').on(
      table.jobName,
      table.scopeKey,
      table.periodKey,
    ),
    index('scheduler_obligations_due_idx')
      .on(table.status, table.dueAt, table.obligationId)
      .where(sql`status IN ('pending', 'failed')`),
    index('scheduler_obligations_lease_idx')
      .on(table.leaseExpiresAt, table.obligationId)
      .where(sql`lease_expires_at IS NOT NULL AND status IN ('enqueued', 'running')`),
    index('scheduler_obligations_failure_idx')
      .on(table.jobName, table.status, table.updatedAt.desc())
      .where(sql`status IN ('failed', 'irrecoverable')`),
    check(
      'scheduler_obligations_status_check',
      sql`status = ANY (ARRAY['pending'::text, 'enqueued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'skipped'::text, 'irrecoverable'::text])`,
    ),
    check(
      'scheduler_obligations_source_check',
      sql`source = ANY (ARRAY['schedule'::text, 'catchup'::text, 'reconcile'::text, 'manual'::text])`,
    ),
    check('scheduler_obligations_generation_check', sql`generation >= 0`),
    check('scheduler_obligations_attempts_check', sql`attempts >= 0`),
    check(
      'scheduler_obligations_last_error_status_check',
      sql`last_error IS NULL OR status IN ('failed'::text, 'irrecoverable'::text)`,
    ),
    check(
      'scheduler_obligations_evidence_object_check',
      sql`jsonb_typeof(evidence) = 'object'::text`,
    ),
    check(
      'scheduler_obligations_lease_check',
      sql`(lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)`,
    ),
    check(
      'scheduler_obligations_identity_check',
      sql`btrim(job_name) <> '' AND btrim(scope_key) <> '' AND btrim(period_key) <> ''`,
    ),
  ],
);

export const schedulerLanesInOps = ops.table(
  'scheduler_lanes',
  {
    laneId: uuid('lane_id').primaryKey().notNull(),
    laneKey: text('lane_key').notNull(),
    jobName: text('job_name').notNull(),
    scopeKey: text('scope_key').notNull(),
    queueName: text('queue_name').notNull(),
    state: text().default('idle').notNull(),
    desiredObligationId: uuid('desired_obligation_id').notNull(),
    desiredDueAt: timestamp('desired_due_at', { withTimezone: true, mode: 'date' }).notNull(),
    activeObligationId: uuid('active_obligation_id'),
    dispatchGeneration: integer('dispatch_generation').default(0).notNull(),
    dispatchOwner: text('dispatch_owner'),
    dispatchLeaseExpiresAt: timestamp('dispatch_lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    bullJobId: text('bull_job_id'),
    runId: uuid('run_id'),
    blockerJobId: text('blocker_job_id'),
    retryNotBefore: timestamp('retry_not_before', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    lastProgressAt: timestamp('last_progress_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    supersededCount: integer('superseded_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('scheduler_lanes_lane_key').on(table.laneKey),
    index('scheduler_lanes_state_idx').on(table.state, table.retryNotBefore, table.updatedAt),
    index('scheduler_lanes_progress_idx').on(table.lastProgressAt, table.laneId),
    check(
      'scheduler_lanes_state_check',
      sql`state = ANY (ARRAY['idle'::text, 'dispatching'::text, 'enqueued'::text, 'running'::text, 'blocked'::text])`,
    ),
    check('scheduler_lanes_generation_check', sql`dispatch_generation >= 0`),
    check('scheduler_lanes_superseded_check', sql`superseded_count >= 0`),
    foreignKey({
      columns: [table.desiredObligationId],
      foreignColumns: [schedulerObligationsInOps.obligationId],
      name: 'scheduler_lanes_desired_obligation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.activeObligationId],
      foreignColumns: [schedulerObligationsInOps.obligationId],
      name: 'scheduler_lanes_active_obligation_fk',
    }).onDelete('restrict'),
    check(
      'scheduler_lanes_identity_check',
      sql`btrim(lane_key) <> '' AND btrim(job_name) <> '' AND btrim(scope_key) <> ''`,
    ),
  ],
);

export const queueHealthWindowsInOps = ops.table(
  'queue_health_windows',
  {
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    queueName: text('queue_name').notNull(),
    waiting: integer().default(0).notNull(),
    active: integer().default(0).notNull(),
    delayed: integer().default(0).notNull(),
    prioritized: integer().default(0).notNull(),
    waitingChildren: integer('waiting_children').default(0).notNull(),
    failed: integer().default(0).notNull(),
    completed: integer().default(0).notNull(),
    runnable: integer().default(0).notNull(),
    oldestRunnableAgeMs: bigint('oldest_runnable_age_ms', { mode: 'number' }),
    arrivals: integer().default(0).notNull(),
    completions: integer().default(0).notNull(),
    failures: integer().default(0).notNull(),
    stalled: integer().default(0).notNull(),
    waitP50Ms: bigint('wait_p50_ms', { mode: 'number' }),
    waitP95Ms: bigint('wait_p95_ms', { mode: 'number' }),
    executionP50Ms: bigint('execution_p50_ms', { mode: 'number' }),
    executionP95Ms: bigint('execution_p95_ms', { mode: 'number' }),
    providerWaitP95Ms: bigint('provider_wait_p95_ms', { mode: 'number' }),
    provider429Rate: numeric('provider_429_rate', { precision: 6, scale: 5 }),
    netGrowth: integer('net_growth').default(0).notNull(),
    drainEtaMs: bigint('drain_eta_ms', { mode: 'number' }),
    backlogClass: text('backlog_class').default('HEALTHY').notNull(),
    admissionMode: text('admission_mode').default('OPEN').notNull(),
    consumerHeartbeatAt: timestamp('consumer_heartbeat_at', { withTimezone: true, mode: 'date' }),
    releaseSha: text('release_sha'),
    evidence: jsonb().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.windowStart, table.queueName],
      name: 'queue_health_windows_pk',
    }),
    index('queue_health_windows_queue_time_idx').on(table.queueName, table.windowStart.desc()),
    index('queue_health_windows_class_time_idx')
      .on(table.backlogClass, table.windowStart.desc())
      .where(sql`backlog_class <> 'HEALTHY'`),
    check('queue_health_windows_queue_nonempty', sql`btrim(queue_name) <> ''`),
    check(
      'queue_health_windows_counts_nonnegative',
      sql`waiting >= 0 AND active >= 0 AND delayed >= 0 AND prioritized >= 0 AND waiting_children >= 0 AND failed >= 0 AND completed >= 0 AND runnable >= 0 AND arrivals >= 0 AND completions >= 0 AND failures >= 0 AND stalled >= 0`,
    ),
    check(
      'queue_health_windows_backlog_class_check',
      sql`backlog_class = ANY (ARRAY['NO_CONSUMER','POISON_STORM','STALLED','DEADLINE_RISK','ADMISSION_SATURATED','PROVIDER_THROTTLED','BURST','HEALTHY'])`,
    ),
    check(
      'queue_health_windows_admission_check',
      sql`admission_mode = ANY (ARRAY['OPEN','DRAIN_ONLY'])`,
    ),
    check('queue_health_windows_evidence_object', sql`jsonb_typeof(evidence) = 'object'`),
  ],
);

export const clientSignalBatchesInOps = ops.table(
  'client_signal_batches',
  {
    batchId: uuid('batch_id').notNull(),
    client: text().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    batchRowId: bigint('batch_row_id', { mode: 'number' })
      .generatedByDefaultAsIdentity()
      .primaryKey(),
  },
  (table) => [
    uniqueIndex('client_signal_batches_batch_id_unique').on(table.batchId),
    index('client_signal_batches_received_idx').on(table.receivedAt.desc()),
    check('client_signal_batches_client_check', sql`client IN ('web','wechat_miniprogram')`),
  ],
);

export const clientSignalWindowsInOps = ops.table(
  'client_signal_windows',
  {
    windowId: bigint('window_id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    client: text().notNull(),
    release: text().notNull(),
    surface: text().notNull(),
    metric: text().notNull(),
    deviceGroup: text('device_group').notNull(),
    sampleSource: text('sample_source').notNull(),
    result: text().notNull(),
    bucket: text().notNull(),
    sampleCount: bigint('sample_count', { mode: 'number' }).default(0).notNull(),
    valueSum: doublePrecision('value_sum').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('client_signal_windows_identity').on(
      table.windowStart,
      table.client,
      table.release,
      table.surface,
      table.metric,
      table.deviceGroup,
      table.sampleSource,
      table.result,
      table.bucket,
    ),
    index('client_signal_windows_client_metric_time_idx').on(
      table.client,
      table.metric,
      table.windowStart.desc(),
    ),
    index('client_signal_windows_retention_idx').on(table.windowStart),
    check('client_signal_windows_client_check', sql`client IN ('web','wechat_miniprogram')`),
    check('client_signal_windows_source_check', sql`sample_source IN ('real','synthetic')`),
    check(
      'client_signal_windows_result_check',
      sql`result IN ('ok','error','timeout','auth_error','stale','unavailable')`,
    ),
    check('client_signal_windows_count_check', sql`sample_count > 0`),
    check('client_signal_windows_value_check', sql`value_sum >= 0`),
    check(
      'client_signal_windows_dimensions_check',
      sql`btrim(release) <> '' AND btrim(surface) <> '' AND btrim(metric) <> '' AND btrim(device_group) <> '' AND btrim(bucket) <> ''`,
    ),
  ],
);

export const dataGovernanceCasesInOps = ops.table(
  'data_governance_cases',
  {
    caseId: bigint('case_id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
    caseKind: text('case_kind').notNull(),
    contractKey: text('contract_key').notNull(),
    lane: text().notNull(),
    obligationId: uuid('obligation_id'),
    sloWindowId: bigint('slo_window_id', { mode: 'number' }),
    scopeKey: text('scope_key').notNull(),
    targetRevision: text('target_revision'),
    errorClass: text('error_class').notNull(),
    errorCode: text('error_code').notNull(),
    fingerprint: text().notNull(),
    evidence: jsonb().default({}).notNull(),
    repairTarget: jsonb('repair_target').default({}).notNull(),
    compensator: text().notNull(),
    attempts: integer().default(0).notNull(),
    status: text().default('OPEN').notNull(),
    lastError: text('last_error'),
    repairJobId: text('repair_job_id'),
    repairDeadlineAt: timestamp('repair_deadline_at', { withTimezone: true, mode: 'date' }),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    // Preserve PostgreSQL microseconds for the compare-and-set token. A
    // JavaScript Date rounds this value to milliseconds, which would make an
    // operator's expectedUpdatedAt fail every CAS against the durable row.
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    recoveredAt: timestamp('recovered_at', { withTimezone: true, mode: 'date' }),
    recoveryRevision: text('recovery_revision'),
  },
  (table) => [
    uniqueIndex('data_governance_cases_open_dedupe_idx')
      .on(table.caseKind, table.contractKey, table.lane, table.scopeKey, table.fingerprint)
      .where(sql`status IN ('OPEN','AUTO_REPAIRING','REQUIRES_REVIEW')`),
    index('data_governance_cases_status_time_idx').on(table.status, table.updatedAt.desc()),
    index('data_governance_cases_slo_idx')
      .on(table.sloWindowId)
      .where(sql`slo_window_id IS NOT NULL`),
    index('data_governance_cases_obligation_idx')
      .on(table.obligationId)
      .where(sql`obligation_id IS NOT NULL`),
    check(
      'data_governance_cases_status_check',
      sql`status = ANY (ARRAY['OPEN','AUTO_REPAIRING','REQUIRES_REVIEW','RECOVERED','DISMISSED'])`,
    ),
    check('data_governance_cases_attempts_check', sql`attempts >= 0`),
    check(
      'data_governance_cases_repair_deadline_check',
      sql`repair_deadline_at IS NULL OR repair_deadline_at >= opened_at`,
    ),
    check(
      'data_governance_cases_key_check',
      sql`btrim(case_kind) <> '' AND btrim(contract_key) <> '' AND btrim(lane) <> '' AND btrim(scope_key) <> '' AND btrim(error_class) <> '' AND btrim(error_code) <> '' AND btrim(fingerprint) <> '' AND btrim(compensator) <> ''`,
    ),
    check('data_governance_cases_evidence_object', sql`jsonb_typeof(evidence) = 'object'`),
    check('data_governance_cases_repair_object', sql`jsonb_typeof(repair_target) = 'object'`),
  ],
);

export const freshnessSloWindowsInOps = ops.table(
  'freshness_slo_windows',
  {
    windowId: bigint('window_id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
    sloKey: text('slo_key').notNull(),
    contractKey: text('contract_key').notNull(),
    seasonId: smallint('season_id'),
    scopeKey: text('scope_key').notNull(),
    periodKey: text('period_key').notNull(),
    eventId: integer('event_id'),
    sourceDay: date('source_day'),
    eligibleAt: timestamp('eligible_at', { withTimezone: true, mode: 'date' }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
    obligationDueAt: timestamp('obligation_due_at', { withTimezone: true, mode: 'date' }),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }),
    pgPublishedAt: timestamp('pg_published_at', { withTimezone: true, mode: 'date' }),
    redisSeenAt: timestamp('redis_seen_at', { withTimezone: true, mode: 'date' }),
    graphqlSeenAt: timestamp('graphql_seen_at', { withTimezone: true, mode: 'date' }),
    webSeenAt: timestamp('web_seen_at', { withTimezone: true, mode: 'date' }),
    producerRevision: text('producer_revision'),
    redisRevision: text('redis_revision'),
    graphqlRevision: text('graphql_revision'),
    webRevision: text('web_revision'),
    expectedCount: integer('expected_count'),
    observedCount: integer('observed_count'),
    notApplicableCount: integer('not_applicable_count').default(0).notNull(),
    completenessStatus: text('completeness_status').default('PENDING').notNull(),
    status: text().default('PENDING').notNull(),
    breachCode: text('breach_code'),
    recoveredAt: timestamp('recovered_at', { withTimezone: true, mode: 'date' }),
    recoveryRevision: text('recovery_revision'),
    evidence: jsonb().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    unique('freshness_slo_windows_identity').on(table.sloKey, table.scopeKey, table.periodKey),
    index('freshness_slo_windows_pending_due_idx')
      .on(table.dueAt, table.windowId)
      .where(sql`status = 'PENDING'`),
    index('freshness_slo_windows_breach_idx')
      .on(table.contractKey, table.status, table.dueAt.desc())
      .where(sql`status IN ('BREACHED','INVALID')`),
    index('freshness_slo_windows_scope_idx').on(
      table.seasonId,
      table.eventId,
      table.contractKey,
      table.dueAt.desc(),
    ),
    check(
      'freshness_slo_windows_status_check',
      sql`status = ANY (ARRAY['PENDING','MET','BREACHED','INVALID','NOT_APPLICABLE'])`,
    ),
    check(
      'freshness_slo_windows_completeness_check',
      sql`completeness_status = ANY (ARRAY['PENDING','COMPLETE','INCOMPLETE','INVALID','NOT_APPLICABLE'])`,
    ),
    check(
      'freshness_slo_windows_counts_check',
      sql`(expected_count IS NULL OR expected_count >= 0) AND (observed_count IS NULL OR observed_count >= 0) AND not_applicable_count >= 0`,
    ),
    check('freshness_slo_windows_time_check', sql`due_at >= eligible_at`),
    check('freshness_slo_windows_evidence_object', sql`jsonb_typeof(evidence) = 'object'`),
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
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    submissionRequestHash: text('submission_request_hash'),
    scrubbedAt: timestamp('scrubbed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('bug_reports_public_id_key').on(table.publicId),
    uniqueIndex('bug_reports_submission_id_key').on(table.submissionId),
    uniqueIndex('bug_reports_screenshot_object_key_key')
      .on(table.screenshotObjectKey)
      .where(sql`screenshot_object_key IS NOT NULL`),
    index('bug_reports_created_idx').on(table.createdAt.desc()),
    index('bug_reports_screenshot_retention_idx')
      .on(table.createdAt.asc())
      .where(sql`screenshot_object_key IS NOT NULL AND screenshot_deleted_at IS NULL`),
    index('bug_reports_user_created_idx')
      .on(table.userId, table.createdAt.desc())
      .where(sql`user_id IS NOT NULL`),
    index('bug_reports_expiry_idx').on(table.expiresAt.asc()),
    index('bug_reports_submission_request_hash_idx')
      .on(table.submissionRequestHash)
      .where(sql`submission_request_hash IS NOT NULL`),
    check('bug_reports_public_id_format', sql`public_id ~ '^LL-([0-9A-F]{6}|[0-9A-F]{12})$'::text`),
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
      sql`(screenshot_object_key IS NULL) OR ((submission_id IS NOT NULL) AND (screenshot_object_key ~* ('^bug-reports/' || submission_id::text || '\\.(jpg|png|webp|gif)$'::text)))`,
    ),
    check(
      'bug_reports_screenshot_https',
      sql`(screenshot_url IS NULL) OR (screenshot_url ~ '^https://'::text)`,
    ),
    check('bug_reports_expiry_after_created', sql`expires_at >= created_at`),
    check(
      'bug_reports_submission_request_hash_format',
      sql`(submission_request_hash IS NULL) OR (submission_request_hash ~ '^[0-9a-f]{64}$'::text)`,
    ),
  ],
);

export const bugReportRetentionBackupsInOps = ops.table(
  'bug_report_retention_backups',
  {
    id: uuid().primaryKey().notNull(),
    publicId: text('public_id').notNull(),
    backedUpAt: timestamp('backed_up_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    snapshot: jsonb().notNull(),
    screenshotDeleteStartedAt: timestamp('screenshot_delete_started_at', {
      withTimezone: true,
      mode: 'date',
    }),
    screenshotDeletedAt: timestamp('screenshot_deleted_at', { withTimezone: true, mode: 'date' }),
    screenshotObjectKey: text('screenshot_object_key'),
    screenshotCreatedAt: timestamp('screenshot_created_at', { withTimezone: true, mode: 'date' }),
    submissionId: uuid('submission_id'),
  },
  (table) => [
    uniqueIndex('bug_report_retention_backups_public_id_key').on(table.publicId),
    index('bug_report_retention_backups_created_idx').on(table.backedUpAt.desc()),
    index('bug_report_retention_backups_screenshot_tombstone_idx')
      .using('btree', sql`((snapshot->>'screenshotUrl'))`)
      .where(sql`screenshot_delete_started_at IS NOT NULL OR screenshot_deleted_at IS NOT NULL`),
    index('bug_report_retention_backups_private_key_idx')
      .on(table.screenshotObjectKey)
      .where(sql`screenshot_object_key IS NOT NULL AND screenshot_deleted_at IS NULL`),
    index('bug_report_retention_backups_screenshot_hash_idx')
      .using('btree', sql`((snapshot->>'screenshotUrlHash'))`)
      .where(sql`(snapshot->>'screenshotUrlHash') IS NOT NULL`),
    uniqueIndex('bug_report_retention_backups_submission_id_key')
      .on(table.submissionId)
      .where(sql`submission_id IS NOT NULL`),
    index('bug_report_retention_backups_private_screenshot_idx')
      .on(table.backedUpAt.asc())
      .where(sql`screenshot_object_key IS NOT NULL AND screenshot_deleted_at IS NULL`),
  ],
);

export const bugReportStorageMigrationsInOps = ops.table(
  'bug_report_storage_migrations',
  {
    id: uuid().primaryKey().notNull(),
    publicId: text('public_id').notNull(),
    sourceLocator: text('source_locator').notNull(),
    targetLocator: text('target_locator').notNull(),
    migratedAt: timestamp('migrated_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    deleteStartedAt: timestamp('delete_started_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('bug_report_storage_migrations_source_key').on(table.sourceLocator),
    index('bug_report_storage_migrations_pending_idx').on(table.deletedAt, table.migratedAt),
    check('bug_report_storage_migrations_source_https', sql`source_locator ~ '^https://'::text`),
    check('bug_report_storage_migrations_target_https', sql`target_locator ~ '^https://'::text`),
  ],
);

export const fplSourceArtifactsInOps = ops.table(
  'fpl_source_artifacts',
  {
    artifactId: uuid('artifact_id').primaryKey().notNull(),
    provider: text().default('fpl').notNull(),
    dataset: text().default('bootstrap-static').notNull(),
    seasonId: smallint('season_id').notNull(),
    sourceDay: date('source_day').notNull(),
    sourceTimezone: text('source_timezone').default('Asia/Shanghai').notNull(),
    sourceUrl: text('source_url').notNull(),
    bucket: text().notNull(),
    objectKey: text('object_key').notNull(),
    sha256: text().notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true, mode: 'date' }).notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    itemCounts: jsonb('item_counts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .default(sql`clock_timestamp()`)
      .notNull(),
  },
  (table) => [
    unique('fpl_source_artifacts_capture_key').on(
      table.provider,
      table.dataset,
      table.seasonId,
      table.sourceDay,
      table.sha256,
    ),
    unique('fpl_source_artifacts_season_artifact_key').on(table.seasonId, table.artifactId),
    unique('fpl_source_artifacts_object_key').on(table.bucket, table.objectKey),
    index('fpl_source_artifacts_day_idx').on(
      table.seasonId,
      table.sourceDay,
      table.retrievedAt.desc(),
      table.artifactId.desc(),
    ),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'fpl_source_artifacts_season_id_fkey',
    }).onDelete('restrict'),
    check('fpl_source_artifacts_provider_check', sql`${table.provider} = 'fpl'`),
    check('fpl_source_artifacts_dataset_check', sql`${table.dataset} = 'bootstrap-static'`),
    check('fpl_source_artifacts_timezone_check', sql`${table.sourceTimezone} = 'Asia/Shanghai'`),
    check(
      'fpl_source_artifacts_url_check',
      sql`${table.sourceUrl} ~ '^https://fantasy\\.premierleague\\.com/api/bootstrap-static/([?].*)?$'`,
    ),
    check('fpl_source_artifacts_bucket_check', sql`${table.bucket} = 'fpl-raw-snapshots'`),
    check(
      'fpl_source_artifacts_object_key_check',
      sql`${table.objectKey} ~ '^fpl/bootstrap-static/[0-9]{4}/[0-9]{8}/[0-9a-f]{64}\\.json$'`,
    ),
    check('fpl_source_artifacts_sha_check', sql`${table.sha256} ~ '^[0-9a-f]{64}$'::text`),
    check(
      'fpl_source_artifacts_size_check',
      sql`${table.byteSize} > 0 AND ${table.byteSize} <= 8388608`,
    ),
    check(
      'fpl_source_artifacts_content_type_check',
      sql`${table.contentType} = 'application/json'`,
    ),
    check('fpl_source_artifacts_schema_version_check', sql`${table.schemaVersion} = 1`),
    check(
      'fpl_source_artifacts_counts_check',
      sql`jsonb_typeof(${table.itemCounts}) = 'object'::text AND (${table.itemCounts}->>'events') ~ '^[0-9]+$' AND (${table.itemCounts}->>'teams') ~ '^[0-9]+$' AND (${table.itemCounts}->>'elements') ~ '^[0-9]+$' AND (${table.itemCounts}->>'phases') ~ '^[0-9]+$'`,
    ),
    check(
      'fpl_source_artifacts_source_day_check',
      sql`(${table.retrievedAt} AT TIME ZONE ${table.sourceTimezone})::date = ${table.sourceDay}`,
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
