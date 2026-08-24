import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { seasonsInFpl } from './platform.schema';

export const content = pgSchema('content');

export const contentSources = content.table(
  'sources',
  {
    sourceId: uuid('source_id').primaryKey().notNull(),
    sourceKey: text('source_key').notNull(),
    platform: text(),
    externalId: text('external_id'),
    handle: text(),
    displayName: text('display_name').notNull(),
    sourceType: text('source_type').notNull(),
    reportingFamily: text('reporting_family').notNull(),
    status: text().default('active').notNull(),
    origin: text().default('MANIFEST').notNull(),
    manifestRevision: text('manifest_revision'),
    rightsPolicy: jsonb('rights_policy').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_sources_source_key_key').on(table.sourceKey),
    unique('content_sources_platform_external_key').on(table.platform, table.externalId),
    check('content_sources_source_key_format_check', sql`source_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      'content_sources_status_check',
      sql`status IN ('active', 'paused', 'observed', 'dormant')`,
    ),
    check('content_sources_origin_check', sql`origin IN ('MANIFEST', 'DISCOVERED')`),
    check(
      'content_sources_manifest_revision_check',
      sql`manifest_revision IS NULL OR manifest_revision ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const contentSourceEndpoints = content.table(
  'source_endpoints',
  {
    endpointId: uuid('endpoint_id').primaryKey().notNull(),
    endpointKey: text('endpoint_key').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => contentSources.sourceId, { onDelete: 'restrict' }),
    adapterKind: text('adapter_kind').notNull(),
    profileKey: text('profile_key').notNull(),
    locator: jsonb().notNull(),
    stableExternalId: text('stable_external_id'),
    identityStatus: text('identity_status').default('PENDING').notNull(),
    identityErrorSummary: text('identity_error_summary'),
    identityCheckedAt: timestamp('identity_checked_at', { withTimezone: true, mode: 'date' }),
    identityNextCheckAt: timestamp('identity_next_check_at', {
      withTimezone: true,
      mode: 'date',
    }),
    status: text().default('active').notNull(),
    origin: text().default('MANIFEST').notNull(),
    rightsPolicy: jsonb('rights_policy').default({}).notNull(),
    manifestRevision: text('manifest_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_endpoints_endpoint_key_key').on(table.endpointKey),
    uniqueIndex('content_source_endpoints_stable_external_idx')
      .on(table.adapterKind, table.stableExternalId)
      .where(sql`stable_external_id IS NOT NULL`),
    index('content_source_endpoints_source_idx').on(
      table.sourceId,
      table.status,
      table.adapterKind,
    ),
    index('content_source_endpoints_identity_due_idx')
      .on(table.identityNextCheckAt, table.endpointId)
      .where(sql`status = 'active' AND identity_status IN ('PENDING', 'FAILED', 'VERIFIED')`),
    check(
      'content_source_endpoints_key_format_check',
      sql`endpoint_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      'content_source_endpoints_adapter_check',
      sql`adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC', 'RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL')`,
    ),
    check(
      'content_source_endpoints_identity_status_check',
      sql`identity_status IN ('PENDING', 'VERIFIED', 'CONFLICT', 'FAILED')`,
    ),
    check(
      'content_source_endpoints_status_check',
      sql`status IN ('active', 'paused', 'observed', 'dormant')`,
    ),
    check('content_source_endpoints_origin_check', sql`origin IN ('MANIFEST', 'DISCOVERED')`),
  ],
);

export const contentSourcePartitions = content.table(
  'source_partitions',
  {
    partitionId: uuid('partition_id').primaryKey().notNull(),
    partitionKey: text('partition_key').notNull(),
    adapterKind: text('adapter_kind').notNull(),
    profileKey: text('profile_key').notNull(),
    priority: integer().notNull(),
    status: text().default('active').notNull(),
    manifestRevision: text('manifest_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_partitions_partition_key_key').on(table.partitionKey),
    check(
      'content_source_partitions_key_format_check',
      sql`partition_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check(
      'content_source_partitions_adapter_check',
      sql`adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC')`,
    ),
    check('content_source_partitions_priority_check', sql`priority BETWEEN 1 AND 1000`),
    check('content_source_partitions_status_check', sql`status IN ('active', 'paused')`),
  ],
);

export const contentSourcePartitionMembers = content.table(
  'source_partition_members',
  {
    partitionId: uuid('partition_id')
      .notNull()
      .references(() => contentSourcePartitions.partitionId, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => contentSourceEndpoints.endpointId, { onDelete: 'restrict' }),
    position: integer().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.partitionId, table.endpointId] }),
    unique('content_source_partition_members_endpoint_key').on(table.endpointId),
    unique('content_source_partition_members_partition_position_key').on(
      table.partitionId,
      table.position,
    ),
    index('content_source_partition_members_endpoint_idx').on(table.endpointId, table.partitionId),
    check('content_source_partition_members_position_check', sql`position >= 0`),
  ],
);

export const contentSourceSchedules = content.table(
  'source_schedules',
  {
    scheduleId: uuid('schedule_id').primaryKey().notNull(),
    scheduleKey: text('schedule_key').notNull(),
    endpointId: uuid('endpoint_id').references(() => contentSourceEndpoints.endpointId, {
      onDelete: 'restrict',
    }),
    partitionId: uuid('partition_id').references(() => contentSourcePartitions.partitionId, {
      onDelete: 'restrict',
    }),
    jobKind: text('job_kind').notNull(),
    adapterKind: text('adapter_kind').notNull(),
    profileKey: text('profile_key').notNull(),
    profileRevision: integer('profile_revision').notNull(),
    scheduleRole: text('schedule_role').default('PRIMARY').notNull(),
    priority: integer().notNull(),
    status: text().default('active').notNull(),
    nextDueAt: timestamp('next_due_at', { withTimezone: true, mode: 'date' }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    failureStreak: integer('failure_streak').default(0).notNull(),
    circuitState: text('circuit_state').default('CLOSED').notNull(),
    probeAfter: timestamp('probe_after', { withTimezone: true, mode: 'date' }),
    cacheNotBefore: timestamp('cache_not_before', { withTimezone: true, mode: 'date' }),
    validator: jsonb().default({}).notNull(),
    checkpoint: jsonb().default({}).notNull(),
    bootstrapCompletedAt: timestamp('bootstrap_completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    bootstrapCutoffAt: timestamp('bootstrap_cutoff_at', { withTimezone: true, mode: 'date' }),
    underLimitStreak: integer('under_limit_streak').default(0).notNull(),
    manifestRevision: text('manifest_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_schedules_schedule_key_key').on(table.scheduleKey),
    uniqueIndex('content_source_schedules_endpoint_target_role_idx')
      .on(table.endpointId, table.scheduleRole)
      .where(sql`endpoint_id IS NOT NULL`),
    uniqueIndex('content_source_schedules_partition_target_role_idx')
      .on(table.partitionId, table.scheduleRole)
      .where(sql`partition_id IS NOT NULL`),
    index('content_source_schedules_due_idx')
      .on(table.priority, table.nextDueAt, table.scheduleId)
      .where(sql`status = 'active' AND lease_expires_at IS NULL`),
    index('content_source_schedules_reclaim_idx')
      .on(table.leaseExpiresAt, table.scheduleId)
      .where(sql`status = 'active' AND lease_expires_at IS NOT NULL`),
    check(
      'content_source_schedules_target_check',
      sql`(endpoint_id IS NOT NULL AND partition_id IS NULL) OR (endpoint_id IS NULL AND partition_id IS NOT NULL)`,
    ),
    check(
      'content_source_schedules_adapter_check',
      sql`adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC', 'RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL')`,
    ),
    check(
      'content_source_schedules_job_kind_check',
      sql`job_kind IN ('X_KEYWORD_SCAN', 'X_SEMANTIC_SCAN', 'FEED_POLL')`,
    ),
    check('content_source_schedules_profile_revision_check', sql`profile_revision >= 1`),
    check('content_source_schedules_priority_check', sql`priority BETWEEN 1 AND 1000`),
    check('content_source_schedules_status_check', sql`status IN ('active', 'paused')`),
    check('content_source_schedules_role_check', sql`schedule_role IN ('PRIMARY', 'BACKSTOP')`),
    check(
      'content_source_schedules_circuit_check',
      sql`circuit_state IN ('CLOSED', 'OPEN', 'HALF_OPEN')`,
    ),
  ],
);

export const contentSourceRegistryReconciliations = content.table(
  'source_registry_reconciliations',
  {
    reconciliationId: uuid('reconciliation_id').primaryKey().notNull(),
    manifestHash: text('manifest_hash').notNull(),
    gitRevision: text('git_revision'),
    status: text().notNull(),
    entityCount: integer('entity_count').default(0).notNull(),
    endpointCount: integer('endpoint_count').default(0).notNull(),
    partitionCount: integer('partition_count').default(0).notNull(),
    scheduleCount: integer('schedule_count').default(0).notNull(),
    details: jsonb().default({}).notNull(),
    errorSummary: text('error_summary'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('content_source_registry_reconciliations_hash_idx').on(
      table.manifestHash,
      table.createdAt,
    ),
    check(
      'content_source_registry_reconciliations_status_check',
      sql`status IN ('RUNNING', 'APPLIED', 'UNCHANGED', 'REJECTED')`,
    ),
  ],
);

export const contentSourceGroups = content.table(
  'source_groups',
  {
    groupId: uuid('group_id').primaryKey().notNull(),
    groupKey: text('group_key').notNull(),
    displayName: text('display_name').notNull(),
    pollPolicy: jsonb('poll_policy').default({}).notNull(),
    status: text().default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [unique('content_source_groups_key').on(table.groupKey)],
);

export const contentSourceGroupMembers = content.table(
  'source_group_members',
  {
    groupId: uuid('group_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    priority: integer().default(100).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.sourceId] }),
    index('content_source_group_members_source_idx').on(table.sourceId),
  ],
);

export const contentAcquisitionCheckpoints = content.table(
  'acquisition_checkpoints',
  {
    groupId: uuid('group_id').notNull(),
    partitionKey: text('partition_key').notNull(),
    cursor: text(),
    sourceSnapshotRevision: text('source_snapshot_revision').notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.partitionKey] })],
);

export const contentAcquisitionBudgets = content.table(
  'acquisition_budgets',
  {
    budgetId: uuid('budget_id').primaryKey().notNull(),
    groupId: uuid('group_id').notNull(),
    budgetDate: date('budget_date', { mode: 'string' }).notNull(),
    budgetScope: text('budget_scope').default('daily').notNull(),
    maxXCalls: integer('max_x_calls').notNull(),
    usedXCalls: integer('used_x_calls').default(0).notNull(),
    maxCostMicros: bigint('max_cost_micros', { mode: 'number' }),
    usedCostMicros: bigint('used_cost_micros', { mode: 'number' }).default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_acquisition_budgets_unique_scope_day').on(
      table.groupId,
      table.budgetDate,
      table.budgetScope,
    ),
    check('content_acquisition_budgets_scope_check', sql`budget_scope IN ('daily', 'final90')`),
    index('content_acquisition_budgets_date_idx').on(table.budgetDate),
  ],
);

export const contentAcquisitionRuns = content.table(
  'acquisition_runs',
  {
    runId: uuid('run_id').primaryKey().notNull(),
    groupId: uuid('group_id'),
    endpointId: uuid('endpoint_id').references(() => contentSourceEndpoints.endpointId, {
      onDelete: 'restrict',
    }),
    sourcePartitionId: uuid('source_partition_id').references(
      () => contentSourcePartitions.partitionId,
      { onDelete: 'restrict' },
    ),
    scheduleId: uuid('schedule_id').references(() => contentSourceSchedules.scheduleId, {
      onDelete: 'restrict',
    }),
    parentRunId: uuid('parent_run_id'),
    targetReceiptId: uuid('target_receipt_id'),
    targetReceiptRevisionId: uuid('target_receipt_revision_id'),
    mode: text(),
    partitionKey: text('partition_key'),
    jobKind: text('job_kind'),
    adapterKind: text('adapter_kind'),
    profileKey: text('profile_key'),
    profileRevision: integer('profile_revision'),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true, mode: 'date' }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text().default('PENDING').notNull(),
    requestSnapshot: jsonb('request_snapshot').default({}).notNull(),
    requestHash: text('request_hash'),
    sourceSnapshot: jsonb('source_snapshot').default([]).notNull(),
    endpointSnapshot: jsonb('endpoint_snapshot').default({}).notNull(),
    sourceSnapshotRevision: text('source_snapshot_revision'),
    attemptNo: integer('attempt_no').default(1).notNull(),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    skillSha: text('skill_sha'),
    adapterVersion: text('adapter_version'),
    xCallCount: integer('x_call_count').default(0).notNull(),
    resultCount: integer('result_count').default(0).notNull(),
    rejectedCount: integer('rejected_count').default(0).notNull(),
    provider: text(),
    providerJobId: text('provider_job_id'),
    providerUnits: numeric('provider_units', { precision: 16, scale: 6 }),
    evidenceMode: text('evidence_mode'),
    traceVerified: boolean('trace_verified').default(false).notNull(),
    checkpointAdvanced: boolean('checkpoint_advanced').default(false).notNull(),
    failureClass: text('failure_class'),
    failureDetailsHash: text('failure_details_hash'),
    runMetrics: jsonb('run_metrics').default({}).notNull(),
    errorSummary: text('error_summary'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    enqueueConfirmedAt: timestamp('enqueue_confirmed_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_acquisition_runs_idempotency_key').on(table.idempotencyKey),
    index('content_acquisition_runs_group_created_idx').on(table.groupId, table.createdAt),
    index('content_acquisition_runs_endpoint_created_idx')
      .on(table.endpointId, table.createdAt)
      .where(sql`endpoint_id IS NOT NULL`),
    index('content_acquisition_runs_partition_created_idx')
      .on(table.sourcePartitionId, table.createdAt)
      .where(sql`source_partition_id IS NOT NULL`),
    index('content_acquisition_runs_parent_idx')
      .on(table.parentRunId, table.createdAt)
      .where(sql`parent_run_id IS NOT NULL`),
    index('content_acquisition_runs_target_receipt_idx')
      .on(table.targetReceiptId, table.createdAt)
      .where(sql`target_receipt_id IS NOT NULL`),
    uniqueIndex('content_acquisition_runs_active_content_target_idx')
      .on(table.jobKind, table.targetReceiptId)
      .where(
        sql`target_receipt_id IS NOT NULL AND job_kind IN ('ARTICLE_FETCH', 'PODCAST_TRANSCRIPT', 'YOUTUBE_METADATA', 'YOUTUBE_TRANSCRIPT') AND status IN ('PENDING', 'RUNNING')`,
      ),
    index('content_acquisition_runs_schedule_created_idx')
      .on(table.scheduleId, table.createdAt)
      .where(sql`schedule_id IS NOT NULL`),
    uniqueIndex('content_acquisition_runs_active_schedule_idx')
      .on(table.scheduleId)
      .where(sql`schedule_id IS NOT NULL AND status IN ('PENDING', 'RUNNING')`),
    uniqueIndex('content_acquisition_runs_active_identity_endpoint_idx')
      .on(table.endpointId)
      .where(sql`job_kind = 'X_IDENTITY' AND status IN ('PENDING', 'RUNNING')`),
    uniqueIndex('content_acquisition_runs_request_attempt_idx')
      .on(table.jobKind, table.requestHash, table.attemptNo)
      .where(sql`job_kind IS NOT NULL AND request_hash IS NOT NULL`),
    uniqueIndex('content_acquisition_runs_provider_job_idx')
      .on(table.provider, table.providerJobId)
      .where(sql`provider IS NOT NULL AND provider_job_id IS NOT NULL`),
    index('content_acquisition_runs_lease_idx')
      .on(table.leaseExpiresAt, table.runId)
      .where(sql`status = 'RUNNING' AND lease_expires_at IS NOT NULL`),
  ],
);

export const contentAcquisitionRunXTraces = content.table(
  'acquisition_run_x_traces',
  {
    runId: uuid('run_id').primaryKey().notNull(),
    toolName: text('tool_name').notNull(),
    skillSha: text('skill_sha').notNull(),
    adapterVersion: text('adapter_version').notNull(),
    requestHash: text('request_hash').notNull(),
    responseHash: text('response_hash'),
    callCount: integer('call_count').default(0).notNull(),
    traceMetadata: jsonb('trace_metadata').default({}).notNull(),
    verified: boolean().default(false).notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('content_acquisition_run_x_traces_verified_idx').on(table.verified, table.capturedAt),
  ],
);

export const contentAcquisitionGaps = content.table(
  'acquisition_gaps',
  {
    gapId: uuid('gap_id').primaryKey().notNull(),
    declaringRunId: uuid('declaring_run_id')
      .notNull()
      .references(() => contentAcquisitionRuns.runId, { onDelete: 'restrict' }),
    endpointId: uuid('endpoint_id').references(() => contentSourceEndpoints.endpointId, {
      onDelete: 'restrict',
    }),
    partitionId: uuid('partition_id').references(() => contentSourcePartitions.partitionId, {
      onDelete: 'restrict',
    }),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true, mode: 'date' }).notNull(),
    reason: text().notNull(),
    detailsHash: text('details_hash'),
    declaredAt: timestamp('declared_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('content_acquisition_gaps_run_window_key').on(
      table.declaringRunId,
      table.windowStart,
      table.windowEnd,
    ),
    index('content_acquisition_gaps_endpoint_idx')
      .on(table.endpointId, table.declaredAt)
      .where(sql`endpoint_id IS NOT NULL`),
    index('content_acquisition_gaps_partition_idx')
      .on(table.partitionId, table.declaredAt)
      .where(sql`partition_id IS NOT NULL`),
  ],
);

export const contentAcquisitionHttpTraces = content.table(
  'acquisition_http_traces',
  {
    traceId: uuid('trace_id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => contentAcquisitionRuns.runId, { onDelete: 'cascade' }),
    operation: text().notNull(),
    sequence: integer().notNull(),
    requestMetadataHash: text('request_metadata_hash').notNull(),
    responseMetadataHash: text('response_metadata_hash'),
    transportBodyHash: text('transport_body_hash'),
    finalUrlHash: text('final_url_hash'),
    httpStatus: integer('http_status'),
    redirectCount: integer('redirect_count').default(0).notNull(),
    responseBytes: bigint('response_bytes', { mode: 'number' }),
    validatorResult: text('validator_result'),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('content_acquisition_http_traces_run_sequence_key').on(table.runId, table.sequence),
    index('content_acquisition_http_traces_run_idx').on(table.runId, table.sequence),
  ],
);

export const contentAcquisitionProviderTraces = content.table(
  'acquisition_provider_traces',
  {
    traceId: uuid('trace_id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => contentAcquisitionRuns.runId, { onDelete: 'cascade' }),
    sequence: integer().notNull(),
    provider: text().notNull(),
    operation: text().notNull(),
    requestMetadataHash: text('request_metadata_hash').notNull(),
    responseMetadataHash: text('response_metadata_hash'),
    providerJobIdHash: text('provider_job_id_hash'),
    providerUnits: numeric('provider_units', { precision: 16, scale: 6 }),
    terminalState: text('terminal_state'),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique('content_acquisition_provider_traces_run_sequence_key').on(table.runId, table.sequence),
    index('content_acquisition_provider_traces_run_idx').on(table.runId, table.sequence),
  ],
);

export const contentAcquisitionJobOutbox = content.table(
  'acquisition_job_outbox',
  {
    outboxId: uuid('outbox_id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => contentAcquisitionRuns.runId, { onDelete: 'restrict' }),
    queueName: text('queue_name').notNull(),
    jobId: text('job_id').notNull(),
    priority: integer().notNull(),
    attempts: integer().default(0).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    leaseOwner: uuid('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    lastErrorHash: text('last_error_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_acquisition_job_outbox_run_key').on(table.runId),
    unique('content_acquisition_job_outbox_job_key').on(table.jobId),
    index('content_acquisition_job_outbox_pending_idx')
      .on(table.availableAt, table.priority, table.createdAt)
      .where(sql`delivered_at IS NULL`),
    index('content_acquisition_job_outbox_reclaim_idx')
      .on(table.leaseExpiresAt, table.outboxId)
      .where(sql`delivered_at IS NULL AND lease_expires_at IS NOT NULL`),
    check(
      'content_acquisition_job_outbox_queue_check',
      sql`queue_name IN ('content-x-scan', 'content-http-acquisition', 'content-media-transcript')`,
    ),
    check('content_acquisition_job_outbox_priority_check', sql`priority BETWEEN 1 AND 1000`),
  ],
);

export const contentAcquisitionBudgetLedgers = content.table(
  'acquisition_budget_ledgers',
  {
    ledgerId: uuid('ledger_id').primaryKey().notNull(),
    scopeKind: text('scope_kind').notNull(),
    scopeKey: text('scope_key').notNull(),
    unitKind: text('unit_kind').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true, mode: 'date' }).notNull(),
    maxUnits: numeric('max_units', { precision: 20, scale: 6 }).notNull(),
    reservedUnits: numeric('reserved_units', { precision: 20, scale: 6 }).default('0').notNull(),
    committedUnits: numeric('committed_units', { precision: 20, scale: 6 }).default('0').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_acquisition_budget_ledgers_scope_window_key').on(
      table.scopeKind,
      table.scopeKey,
      table.unitKind,
      table.windowStart,
      table.windowEnd,
    ),
  ],
);

export const contentAcquisitionBudgetReservations = content.table(
  'acquisition_budget_reservations',
  {
    reservationId: uuid('reservation_id').primaryKey().notNull(),
    ledgerId: uuid('ledger_id')
      .notNull()
      .references(() => contentAcquisitionBudgetLedgers.ledgerId, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => contentAcquisitionRuns.runId, { onDelete: 'restrict' }),
    units: numeric({ precision: 20, scale: 6 }).notNull(),
    status: text().default('RESERVED').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('content_acquisition_budget_reservations_ledger_status_idx').on(
      table.ledgerId,
      table.status,
    ),
    index('content_acquisition_budget_reservations_run_idx').on(table.runId),
  ],
);

export const contentSourceReceipts = content.table(
  'source_receipts',
  {
    receiptId: uuid('receipt_id').primaryKey().notNull(),
    receiptKey: text('receipt_key').notNull(),
    runId: uuid('run_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    primaryEndpointId: uuid('primary_endpoint_id').references(
      () => contentSourceEndpoints.endpointId,
      { onDelete: 'restrict' },
    ),
    externalId: text('external_id').notNull(),
    contentKind: text('content_kind').default('POST').notNull(),
    canonicalUrl: text('canonical_url'),
    currentRevisionId: uuid('current_revision_id'),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    payload: jsonb().default({}).notNull(),
    canonicalHash: text('canonical_hash').notNull(),
    rightsPolicy: jsonb('rights_policy').default({}).notNull(),
    workPlannerCheckedAt: timestamp('work_planner_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_receipts_receipt_key_key').on(table.receiptKey),
    index('content_source_receipts_run_idx').on(table.runId, table.capturedAt),
    index('content_source_receipts_endpoint_idx')
      .on(table.primaryEndpointId, table.createdAt)
      .where(sql`primary_endpoint_id IS NOT NULL`),
    index('content_source_receipts_work_planner_idx')
      .on(table.workPlannerCheckedAt, table.createdAt)
      .where(sql`content_kind IN ('ARTICLE', 'EPISODE', 'VIDEO')`),
  ],
);

export const contentSourceReceiptRevisions = content.table(
  'source_receipt_revisions',
  {
    receiptRevisionId: uuid('receipt_revision_id').primaryKey().notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => contentSourceReceipts.receiptId, { onDelete: 'restrict' }),
    revisionNumber: integer('revision_number').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => contentAcquisitionRuns.runId, { onDelete: 'restrict' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => contentSourceEndpoints.endpointId, { onDelete: 'restrict' }),
    payload: jsonb().notNull(),
    canonicalHash: text('canonical_hash').notNull(),
    bodyAvailability: text('body_availability').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_receipt_revisions_receipt_number_key').on(
      table.receiptId,
      table.revisionNumber,
    ),
    unique('content_source_receipt_revisions_run_receipt_key').on(table.runId, table.receiptId),
    index('content_source_receipt_revisions_receipt_created_idx').on(
      table.receiptId,
      table.createdAt,
    ),
    index('content_source_receipt_revisions_endpoint_created_idx').on(
      table.endpointId,
      table.createdAt,
    ),
  ],
);

export const contentSourceTranscriptRevisions = content.table(
  'source_transcript_revisions',
  {
    transcriptRevisionId: uuid('transcript_revision_id').primaryKey().notNull(),
    receiptRevisionId: uuid('receipt_revision_id')
      .notNull()
      .references(() => contentSourceReceiptRevisions.receiptRevisionId, {
        onDelete: 'restrict',
      }),
    transcriptRevisionNumber: integer('transcript_revision_number').notNull(),
    status: text().notNull(),
    provider: text(),
    engine: text(),
    modelRevision: text('model_revision'),
    optionsRevision: text('options_revision'),
    language: text(),
    trackKind: text('track_kind'),
    mediaHash: text('media_hash'),
    segmentsHash: text('segments_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_transcript_revisions_receipt_number_key').on(
      table.receiptRevisionId,
      table.transcriptRevisionNumber,
    ),
  ],
);

export const contentSourceTranscriptSegments = content.table(
  'source_transcript_segments',
  {
    transcriptRevisionId: uuid('transcript_revision_id')
      .notNull()
      .references(() => contentSourceTranscriptRevisions.transcriptRevisionId, {
        onDelete: 'restrict',
      }),
    ordinal: integer().notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    normalizedText: text('normalized_text').notNull(),
    segmentHash: text('segment_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.transcriptRevisionId, table.ordinal] }),
    index('content_source_transcript_segments_hash_idx').on(table.segmentHash),
  ],
);

export const contentSourceObservations = content.table(
  'source_observations',
  {
    observationId: uuid('observation_id').primaryKey().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => contentAcquisitionRuns.runId, { onDelete: 'restrict' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => contentSourceEndpoints.endpointId, { onDelete: 'restrict' }),
    externalItemId: text('external_item_id').notNull(),
    receiptId: uuid('receipt_id').references(() => contentSourceReceipts.receiptId, {
      onDelete: 'restrict',
    }),
    receiptRevisionId: uuid('receipt_revision_id').references(
      () => contentSourceReceiptRevisions.receiptRevisionId,
      { onDelete: 'restrict' },
    ),
    outcome: text().notNull(),
    nativeItemHash: text('native_item_hash'),
    reasonCode: text('reason_code'),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_observations_run_item_key').on(
      table.runId,
      table.endpointId,
      table.externalItemId,
    ),
    index('content_source_observations_receipt_idx')
      .on(table.receiptId, table.observedAt)
      .where(sql`receipt_id IS NOT NULL`),
    index('content_source_observations_endpoint_idx').on(table.endpointId, table.observedAt),
  ],
);

export const contentSourceMediaGates = content.table(
  'source_media_gates',
  {
    gateId: uuid('gate_id').primaryKey().notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => contentSourceReceipts.receiptId, { onDelete: 'restrict' }),
    receiptRevisionId: uuid('receipt_revision_id')
      .notNull()
      .references(() => contentSourceReceiptRevisions.receiptRevisionId, {
        onDelete: 'restrict',
      }),
    postId: text('post_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    requestHash: text('request_hash').notNull(),
    seasonId: smallint('season_id').references(() => seasonsInFpl.seasonId, {
      onDelete: 'restrict',
    }),
    retainUntil: date('retain_until'),
    status: text().default('PENDING').notNull(),
    releaseDeadlineAt: timestamp('release_deadline_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    repairUntilAt: timestamp('repair_until_at', { withTimezone: true, mode: 'date' }).notNull(),
    repairExhaustedAt: timestamp('repair_exhausted_at', {
      withTimezone: true,
      mode: 'date',
    }),
    attemptCount: integer('attempt_count').default(0).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    firstAttemptAt: timestamp('first_attempt_at', { withTimezone: true, mode: 'date' }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    lastFailureClass: text('last_failure_class'),
    lastFailureHash: text('last_failure_hash'),
    discoveredCount: integer('discovered_count').default(0).notNull(),
    archivedCount: integer('archived_count').default(0).notNull(),
    rejectedCount: integer('rejected_count').default(0).notNull(),
    mediaStateHash: text('media_state_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_media_gates_revision_key').on(table.receiptRevisionId),
    index('content_source_media_gates_receipt_idx').on(table.receiptId, table.createdAt.desc()),
    index('content_source_media_gates_season_idx')
      .on(table.seasonId, table.retainUntil)
      .where(sql`season_id IS NOT NULL`),
    index('content_source_media_gates_due_idx')
      .on(table.nextAttemptAt, table.releaseDeadlineAt, table.gateId)
      .where(
        sql`status IN ('PENDING', 'PARTIAL', 'UNAVAILABLE') AND next_attempt_at IS NOT NULL AND repair_exhausted_at IS NULL`,
      ),
    index('content_source_media_gates_reclaim_idx')
      .on(table.leaseExpiresAt, table.gateId)
      .where(sql`status = 'RUNNING'`),
  ],
);

export const contentSourceMediaAssets = content.table(
  'source_media_assets',
  {
    assetId: uuid('asset_id').primaryKey().notNull(),
    sha256: text().notNull(),
    objectKey: text('object_key').notNull(),
    actualMime: text('actual_mime').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    bucket: text().notNull(),
    storageState: text('storage_state').default('RESERVED').notNull(),
    uploadLeaseOwner: text('upload_lease_owner'),
    uploadLeaseExpiresAt: timestamp('upload_lease_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    lastFailureHash: text('last_failure_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_media_assets_sha_key').on(table.sha256),
    unique('content_source_media_assets_object_key_key').on(table.objectKey),
    index('content_source_media_assets_state_idx').on(table.storageState, table.updatedAt),
    index('content_source_media_assets_upload_lease_idx')
      .on(table.uploadLeaseExpiresAt, table.assetId)
      .where(sql`upload_lease_expires_at IS NOT NULL`),
  ],
);

export const contentSourceMediaItems = content.table(
  'source_media_items',
  {
    itemId: uuid('item_id').primaryKey().notNull(),
    gateId: uuid('gate_id')
      .notNull()
      .references(() => contentSourceMediaGates.gateId, { onDelete: 'restrict' }),
    ordinal: integer().notNull(),
    role: text().notNull(),
    sourceUrl: text('source_url').notNull(),
    altText: text('alt_text'),
    sourceVariant: text('source_variant').notNull(),
    actualMime: text('actual_mime'),
    archiveStatus: text('archive_status').default('PENDING').notNull(),
    assetId: uuid('asset_id').references(() => contentSourceMediaAssets.assetId, {
      onDelete: 'restrict',
    }),
    failureClass: text('failure_class'),
    failureHash: text('failure_hash'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_media_items_gate_ordinal_key').on(table.gateId, table.ordinal),
    index('content_source_media_items_gate_idx').on(table.gateId, table.ordinal),
    index('content_source_media_items_asset_idx')
      .on(table.assetId)
      .where(sql`asset_id IS NOT NULL`),
    index('content_source_media_items_archive_status_idx').on(table.archiveStatus, table.updatedAt),
  ],
);

export const contentPipelineOutbox = content.table(
  'pipeline_outbox',
  {
    outboxId: uuid('outbox_id').primaryKey().notNull(),
    eventKey: text('event_key').notNull(),
    eventType: text('event_type').notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => contentSourceReceipts.receiptId, { onDelete: 'restrict' }),
    receiptRevisionId: uuid('receipt_revision_id')
      .notNull()
      .references(() => contentSourceReceiptRevisions.receiptRevisionId, {
        onDelete: 'restrict',
      }),
    runId: uuid('run_id')
      .notNull()
      .references(() => contentAcquisitionRuns.runId, { onDelete: 'restrict' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => contentSources.sourceId, { onDelete: 'restrict' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => contentSourceEndpoints.endpointId, { onDelete: 'restrict' }),
    mediaGateId: uuid('media_gate_id').references(() => contentSourceMediaGates.gateId, {
      onDelete: 'restrict',
    }),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    payload: jsonb().notNull(),
    status: text().default('PENDING').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    lastErrorSummary: text('last_error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_pipeline_outbox_event_key_key').on(table.eventKey),
    index('content_pipeline_outbox_pending_idx')
      .on(table.availableAt, table.outboxId)
      .where(sql`status = 'PENDING' AND lease_expires_at IS NULL`),
    index('content_pipeline_outbox_reclaim_idx')
      .on(table.leaseExpiresAt, table.outboxId)
      .where(sql`status = 'PENDING' AND lease_expires_at IS NOT NULL`),
    index('content_pipeline_outbox_media_gate_idx')
      .on(table.mediaGateId, table.status, table.availableAt)
      .where(sql`media_gate_id IS NOT NULL`),
  ],
);

export const contentCandidateClusters = content.table('candidate_clusters', {
  candidateId: uuid('candidate_id').primaryKey().notNull(),
  runId: uuid('run_id').notNull(),
  canonicalHash: text('canonical_hash').notNull(),
  status: text().default('new').notNull(),
  materiality: text().default('unknown').notNull(),
  receiptIds: jsonb('receipt_ids').default([]).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export const contentStories = content.table(
  'stories',
  {
    storyId: uuid('story_id').primaryKey().notNull(),
    versionGroupId: uuid('version_group_id').notNull(),
    canonicalSlug: text('canonical_slug').notNull(),
    storyRevision: integer('story_revision').default(1).notNull(),
    status: text().default('draft').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_stories_canonical_slug').on(table.canonicalSlug),
    index('content_stories_version_group_idx').on(table.versionGroupId),
  ],
);

export const contentStoryLocalizations = content.table(
  'story_localizations',
  {
    localizationId: uuid('localization_id').primaryKey().notNull(),
    versionGroupId: uuid('version_group_id').notNull(),
    locale: text().notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    body: text().notNull(),
    sourceAttribution: text('source_attribution'),
    claims: jsonb().default([]).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_story_localizations_version_locale_key').on(table.versionGroupId, table.locale),
    index('content_story_localizations_locale_idx').on(table.locale, table.versionGroupId),
  ],
);

export const contentStoryEvidence = content.table(
  'story_evidence',
  {
    storyId: uuid('story_id').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    evidenceRole: text('evidence_role').default('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.storyId, table.receiptId] })],
);

export const contentEntities = content.table(
  'entities',
  {
    entityId: uuid('entity_id').primaryKey().notNull(),
    entityType: text('entity_type').notNull(),
    canonicalKey: text('canonical_key').notNull(),
    displayName: text('display_name').notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [unique('content_entities_type_key').on(table.entityType, table.canonicalKey)],
);

export const contentStoryEntities = content.table(
  'story_entities',
  {
    storyId: uuid('story_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    entityRole: text('entity_role').default('mentioned').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.storyId, table.entityId] }),
    index('content_story_entities_entity_idx').on(table.entityId),
  ],
);

export const contentClaims = content.table(
  'claims',
  {
    claimId: uuid('claim_id').primaryKey().notNull(),
    storyId: uuid('story_id').notNull(),
    claimKey: text('claim_key').notNull(),
    statement: text().notNull(),
    status: text().default('unverified').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4, mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_claims_story_key').on(table.storyId, table.claimKey),
    index('content_claims_story_idx').on(table.storyId, table.updatedAt),
  ],
);

export const contentClaimEvidence = content.table(
  'claim_evidence',
  {
    claimId: uuid('claim_id').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.claimId, table.receiptId] }),
    index('content_claim_evidence_receipt_idx').on(table.receiptId),
  ],
);

export const contentWeekEditions = content.table('week_editions', {
  editionId: uuid('edition_id').primaryKey().notNull(),
  seasonCode: text('season_code').notNull(),
  eventId: integer('event_id').notNull(),
  eventName: text('event_name').notNull(),
  deadlineTime: timestamp('deadline_time', { withTimezone: true, mode: 'date' }).notNull(),
  sourceSnapshotRevision: text('source_snapshot_revision').notNull(),
  status: text().default('draft').notNull(),
  readyAt: timestamp('ready_at', { withTimezone: true, mode: 'date' }),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
  publishedPublicationId: uuid('published_publication_id'),
  frozenSha256: text('frozen_sha256'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export const contentWeekEditionSourceRuns = content.table(
  'week_edition_source_runs',
  {
    editionId: uuid('edition_id').notNull(),
    runId: uuid('run_id').notNull(),
    sourceSnapshotRevision: text('source_snapshot_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.editionId, table.runId] })],
);

export const contentWeekEditionSnapshots = content.table(
  'week_edition_snapshots',
  {
    snapshotId: uuid('snapshot_id').primaryKey().notNull(),
    editionId: uuid('edition_id').notNull(),
    sourceRunIds: jsonb('source_run_ids').notNull(),
    sourceSnapshotRevision: text('source_snapshot_revision').notNull(),
    eventProjection: jsonb('event_projection').notNull(),
    itemsProjection: jsonb('items_projection').notNull(),
    frozenSha256: text('frozen_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [unique('content_week_edition_snapshots_edition_key').on(table.editionId)],
);

export const contentWeekEditionItems = content.table(
  'week_edition_items',
  {
    editionId: uuid('edition_id').notNull(),
    storyId: uuid('story_id').notNull(),
    sectionKey: text('section_key').notNull(),
    placement: text().default('standard').notNull(),
    position: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.editionId, table.storyId] }),
    index('content_week_edition_items_placement_idx').on(
      table.editionId,
      table.sectionKey,
      table.position,
    ),
  ],
);

export const contentPublications = content.table(
  'publications',
  {
    publicationId: uuid('publication_id').primaryKey().notNull(),
    scopeKey: text('scope_key').notNull(),
    revision: bigint({ mode: 'number' }).notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    seasonCode: text('season_code').notNull(),
    targetEventId: integer('target_event_id'),
    eventName: text('event_name'),
    deadlineTime: timestamp('deadline_time', { withTimezone: true, mode: 'date' }),
    state: text().notNull(),
    status: text().default('staging').notNull(),
    servable: boolean().default(false).notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }),
    localeManifest: jsonb('locale_manifest').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('content_publications_scope_revision_key').on(table.scopeKey, table.revision),
    uniqueIndex('content_publications_one_active_scope_idx')
      .on(table.scopeKey)
      .where(sql`status = 'active' AND servable = true`),
    index('content_publications_active_lookup_idx').on(
      table.scopeKey,
      table.status,
      table.servable,
      table.revision,
    ),
  ],
);

export const contentPublicationPayloads = content.table(
  'publication_payloads',
  {
    publicationId: uuid('publication_id').notNull(),
    locale: text().notNull(),
    payload: jsonb().notNull(),
    payloadBytes: integer('payload_bytes').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.publicationId, table.locale] })],
);

export const contentPublicationOutbox = content.table(
  'publication_outbox',
  {
    outboxId: uuid('outbox_id').primaryKey().notNull(),
    eventType: text('event_type').notNull(),
    publicationId: uuid('publication_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb().notNull(),
    attempts: integer().default(0).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_publication_outbox_idempotency_key').on(table.idempotencyKey),
    index('content_publication_outbox_pending_idx').on(table.createdAt),
  ],
);

export const contentAcquisitionCosts = content.table('acquisition_costs', {
  costId: uuid('cost_id').primaryKey().notNull(),
  runId: uuid('run_id').notNull(),
  provider: text().notNull(),
  amountMicros: bigint('amount_micros', { mode: 'number' }).default(0).notNull(),
  currency: text().default('USD').notNull(),
  units: integer().default(0).notNull(),
  metadata: jsonb().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});

export const contentPublicationDependencies = content.table(
  'publication_dependencies',
  {
    publicationId: uuid('publication_id').notNull(),
    dependencyKind: text('dependency_kind').notNull(),
    dependencyKey: text('dependency_key').notNull(),
    dependencyRevision: text('dependency_revision'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.publicationId, table.dependencyKind, table.dependencyKey] }),
    index('content_publication_dependencies_key_idx').on(table.dependencyKind, table.dependencyKey),
  ],
);

export const contentEditorialActions = content.table(
  'editorial_actions',
  {
    actionId: uuid('action_id').primaryKey().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    actorId: text('actor_id').notNull(),
    role: text().notNull(),
    actionType: text('action_type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    payload: jsonb().default({}).notNull(),
    requestHash: text('request_hash'),
    resultPayload: jsonb('result_payload').default({}).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_editorial_actions_idempotency_key').on(table.idempotencyKey),
    index('content_editorial_actions_entity_idx').on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
  ],
);

export const contentAcquisitionEndpointHealth = content
  .view('acquisition_endpoint_health', {
    endpointId: uuid('endpoint_id').notNull(),
    endpointKey: text('endpoint_key').notNull(),
    sourceKey: text('source_key').notNull(),
    adapterKind: text('adapter_kind').notNull(),
    profileKey: text('profile_key').notNull(),
    identityStatus: text('identity_status').notNull(),
    endpointStatus: text('endpoint_status').notNull(),
    identityCheckedAt: timestamp('identity_checked_at', { withTimezone: true, mode: 'date' }),
    identityNextCheckAt: timestamp('identity_next_check_at', {
      withTimezone: true,
      mode: 'date',
    }),
    partitionId: uuid('partition_id'),
    partitionKey: text('partition_key'),
    scheduleId: uuid('schedule_id'),
    scheduleKey: text('schedule_key'),
    scheduleStatus: text('schedule_status'),
    nextDueAt: timestamp('next_due_at', { withTimezone: true, mode: 'date' }),
    dueLagSeconds: bigint('due_lag_seconds', { mode: 'number' }),
    checkpointCheckedAt: timestamp('checkpoint_checked_at', {
      withTimezone: true,
      mode: 'date',
    }),
    checkpointAgeSeconds: bigint('checkpoint_age_seconds', { mode: 'number' }),
    failureStreak: integer('failure_streak'),
    circuitState: text('circuit_state'),
    probeAfter: timestamp('probe_after', { withTimezone: true, mode: 'date' }),
    cacheNotBefore: timestamp('cache_not_before', { withTimezone: true, mode: 'date' }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    bootstrapCompletedAt: timestamp('bootstrap_completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    latestRunId: uuid('latest_run_id'),
    latestJobKind: text('latest_job_kind'),
    latestRunStatus: text('latest_run_status'),
    latestRunCreatedAt: timestamp('latest_run_created_at', {
      withTimezone: true,
      mode: 'date',
    }),
    latestRunStartedAt: timestamp('latest_run_started_at', {
      withTimezone: true,
      mode: 'date',
    }),
    latestRunCompletedAt: timestamp('latest_run_completed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    latestLatencyMs: bigint('latest_latency_ms', { mode: 'number' }),
    latestResultCount: integer('latest_result_count'),
    latestRejectedCount: integer('latest_rejected_count'),
    latestFailureClass: text('latest_failure_class'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true, mode: 'date' }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'date' }),
    lastSaturatedAt: timestamp('last_saturated_at', { withTimezone: true, mode: 'date' }),
    lastGapAt: timestamp('last_gap_at', { withTimezone: true, mode: 'date' }),
    lastContentDeferredAt: timestamp('last_content_deferred_at', {
      withTimezone: true,
      mode: 'date',
    }),
    p50LatencyMs: bigint('p50_latency_ms', { mode: 'number' }),
    p95LatencyMs: bigint('p95_latency_ms', { mode: 'number' }),
    pendingProviderJobCount: integer('pending_provider_job_count'),
    oldestPendingProviderJobAt: timestamp('oldest_pending_provider_job_at', {
      withTimezone: true,
      mode: 'date',
    }),
    pendingProviderJobAgeSeconds: bigint('pending_provider_job_age_seconds', { mode: 'number' }),
    latestGapReason: text('latest_gap_reason'),
    latestGapDeclaredAt: timestamp('latest_gap_declared_at', {
      withTimezone: true,
      mode: 'date',
    }),
    manifestReconcileStatus: text('manifest_reconcile_status'),
    manifestReconcileError: text('manifest_reconcile_error'),
    manifestReconciledAt: timestamp('manifest_reconciled_at', {
      withTimezone: true,
      mode: 'date',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
  })
  .with({ securityInvoker: true })
  .as(
    sql`SELECT endpoint.endpoint_id, endpoint.endpoint_key, source.source_key, endpoint.adapter_kind, endpoint.profile_key, endpoint.identity_status, endpoint.status AS endpoint_status, endpoint.identity_checked_at, endpoint.identity_next_check_at, partition.partition_id, partition.partition_key, schedule.schedule_id, schedule.schedule_key, schedule.status AS schedule_status, schedule.next_due_at, GREATEST(0, EXTRACT(EPOCH FROM (now() - schedule.next_due_at)))::bigint AS due_lag_seconds, schedule.failure_streak, schedule.circuit_state, schedule.probe_after, schedule.cache_not_before, schedule.lease_expires_at, schedule.bootstrap_completed_at, schedule.updated_at, CASE WHEN schedule.checkpoint ? 'checkedAt' THEN (schedule.checkpoint ->> 'checkedAt')::timestamptz ELSE NULL END AS checkpoint_checked_at, CASE WHEN schedule.checkpoint ? 'checkedAt' THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - (schedule.checkpoint ->> 'checkedAt')::timestamptz)))::bigint ELSE NULL END AS checkpoint_age_seconds, latest_run.run_id AS latest_run_id, latest_run.job_kind AS latest_job_kind, latest_run.status AS latest_run_status, latest_run.created_at AS latest_run_created_at, latest_run.started_at AS latest_run_started_at, latest_run.completed_at AS latest_run_completed_at, CASE WHEN latest_run.started_at IS NOT NULL AND latest_run.completed_at IS NOT NULL THEN GREATEST(0, EXTRACT(EPOCH FROM (latest_run.completed_at - latest_run.started_at)) * 1000)::bigint ELSE NULL END AS latest_latency_ms, latest_run.result_count AS latest_result_count, latest_run.rejected_count AS latest_rejected_count, latest_run.failure_class AS latest_failure_class, history.last_success_at, history.last_failure_at, history.last_saturated_at, history.last_gap_at, history.last_content_deferred_at, history.p50_latency_ms, history.p95_latency_ms, pending_provider.pending_provider_job_count, pending_provider.oldest_pending_provider_job_at, CASE WHEN pending_provider.oldest_pending_provider_job_at IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (now() - pending_provider.oldest_pending_provider_job_at)))::bigint END AS pending_provider_job_age_seconds, latest_gap.reason AS latest_gap_reason, latest_gap.declared_at AS latest_gap_declared_at, reconciliation.status AS manifest_reconcile_status, reconciliation.error_summary AS manifest_reconcile_error, reconciliation.created_at AS manifest_reconciled_at FROM content.source_endpoints AS endpoint JOIN content.sources AS source ON source.source_id = endpoint.source_id LEFT JOIN content.source_partition_members AS member ON member.endpoint_id = endpoint.endpoint_id LEFT JOIN content.source_partitions AS partition ON partition.partition_id = member.partition_id LEFT JOIN content.source_schedules AS schedule ON schedule.endpoint_id = endpoint.endpoint_id OR schedule.partition_id = partition.partition_id LEFT JOIN LATERAL (SELECT run.* FROM content.acquisition_runs AS run WHERE run.endpoint_id = endpoint.endpoint_id OR (partition.partition_id IS NOT NULL AND run.source_partition_id = partition.partition_id) ORDER BY run.created_at DESC, run.run_id DESC LIMIT 1) AS latest_run ON true LEFT JOIN LATERAL (SELECT max(run.completed_at) FILTER (WHERE run.status IN ('EMPTY', 'CHECKED_NO_CHANGE', 'COMPLETED', 'PARTIAL', 'SATURATED')) AS last_success_at, max(run.completed_at) FILTER (WHERE run.status = 'FAILED') AS last_failure_at, max(run.completed_at) FILTER (WHERE run.status = 'SATURATED') AS last_saturated_at, max(run.completed_at) FILTER (WHERE run.status = 'GAP') AS last_gap_at, max(run.completed_at) FILTER (WHERE run.status = 'CONTENT_DEFERRED') AS last_content_deferred_at, (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (run.completed_at - run.started_at)) * 1000) FILTER (WHERE run.started_at IS NOT NULL AND run.completed_at IS NOT NULL))::bigint AS p50_latency_ms, (percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (run.completed_at - run.started_at)) * 1000) FILTER (WHERE run.started_at IS NOT NULL AND run.completed_at IS NOT NULL))::bigint AS p95_latency_ms FROM (SELECT candidate.* FROM content.acquisition_runs AS candidate WHERE candidate.endpoint_id = endpoint.endpoint_id OR (partition.partition_id IS NOT NULL AND candidate.source_partition_id = partition.partition_id) ORDER BY candidate.created_at DESC LIMIT 50) AS run) AS history ON true LEFT JOIN LATERAL (SELECT count(*)::integer AS pending_provider_job_count, min(run.created_at) AS oldest_pending_provider_job_at FROM content.acquisition_runs AS run WHERE run.endpoint_id = endpoint.endpoint_id AND run.provider_job_id IS NOT NULL AND run.status IN ('PENDING', 'RUNNING')) AS pending_provider ON true LEFT JOIN LATERAL (SELECT gap.reason, gap.declared_at FROM content.acquisition_gaps AS gap WHERE gap.endpoint_id = endpoint.endpoint_id OR (partition.partition_id IS NOT NULL AND gap.partition_id = partition.partition_id) ORDER BY gap.declared_at DESC LIMIT 1) AS latest_gap ON true LEFT JOIN LATERAL (SELECT result.status, result.error_summary, result.created_at FROM content.source_registry_reconciliations AS result ORDER BY result.created_at DESC LIMIT 1) AS reconciliation ON true`,
  );

export const contentAcquisitionScheduleHealth = content
  .view('acquisition_schedule_health', {
    scheduleId: uuid('schedule_id').notNull(),
    scheduleKey: text('schedule_key').notNull(),
    scheduleRole: text('schedule_role').notNull(),
    adapterKind: text('adapter_kind').notNull(),
    partitionId: uuid('partition_id'),
    partitionKey: text('partition_key'),
    status: text('status').notNull(),
    nextDueAt: timestamp('next_due_at', { withTimezone: true, mode: 'date' }).notNull(),
    dueLagSeconds: bigint('due_lag_seconds', { mode: 'number' }).notNull(),
    checkpointAgeSeconds: bigint('checkpoint_age_seconds', { mode: 'number' }),
    failureStreak: integer('failure_streak').notNull(),
    circuitState: text('circuit_state').notNull(),
    probeAfter: timestamp('probe_after', { withTimezone: true, mode: 'date' }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    latestRunId: uuid('latest_run_id'),
    latestRunStatus: text('latest_run_status'),
    latestFailureClass: text('latest_failure_class'),
  })
  .with({ securityInvoker: true })
  .as(
    sql`SELECT schedule.schedule_id,
               schedule.schedule_key,
               schedule.schedule_role,
               schedule.adapter_kind,
               schedule.partition_id,
               partition.partition_key,
               schedule.status,
               schedule.next_due_at,
               GREATEST(0, EXTRACT(EPOCH FROM (now() - schedule.next_due_at)))::bigint AS due_lag_seconds,
               CASE WHEN schedule.checkpoint ? 'checkedAt'
                 THEN GREATEST(0, EXTRACT(EPOCH FROM (now() - (schedule.checkpoint ->> 'checkedAt')::timestamptz)))::bigint
                 ELSE NULL END AS checkpoint_age_seconds,
               schedule.failure_streak,
               schedule.circuit_state,
               schedule.probe_after,
               schedule.lease_expires_at,
               latest_run.run_id AS latest_run_id,
               latest_run.status AS latest_run_status,
               latest_run.failure_class AS latest_failure_class
        FROM content.source_schedules AS schedule
        LEFT JOIN content.source_partitions AS partition
          ON partition.partition_id = schedule.partition_id
        LEFT JOIN LATERAL (
          SELECT run.run_id, run.status, run.failure_class
          FROM content.acquisition_runs AS run
          WHERE run.schedule_id = schedule.schedule_id
          ORDER BY run.created_at DESC, run.run_id DESC
          LIMIT 1
        ) AS latest_run ON true`,
  );

export const contentBriefingActivePublication = content
  .view('briefing_active_publication', {
    publicationId: uuid('publication_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    revision: bigint({ mode: 'number' }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    seasonCode: text('season_code').notNull(),
    targetEventId: integer('target_event_id'),
    eventName: text('event_name'),
    deadlineTime: timestamp('deadline_time', { withTimezone: true, mode: 'date' }),
    state: text().notNull(),
    servable: boolean().notNull(),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }),
    localeManifest: jsonb('locale_manifest').notNull(),
  })
  .as(
    sql`SELECT publication_id, scope_key, revision, schema_version, season_code, target_event_id, event_name, deadline_time, state, servable, source_checked_at, published_at, valid_until, locale_manifest FROM content.publications WHERE status = 'active' AND servable = true`,
  );
