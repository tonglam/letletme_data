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
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const content = pgSchema('content');

export const contentSources = content.table(
  'sources',
  {
    sourceId: uuid('source_id').primaryKey().notNull(),
    platform: text().notNull(),
    externalId: text('external_id').notNull(),
    handle: text(),
    displayName: text('display_name').notNull(),
    sourceType: text('source_type').notNull(),
    reportingFamily: text('reporting_family').notNull(),
    status: text().default('active').notNull(),
    rightsPolicy: jsonb('rights_policy').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_sources_platform_external_key').on(table.platform, table.externalId),
    check('content_sources_status_check', sql`status IN ('active', 'paused', 'disabled')`),
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
    groupId: uuid('group_id').notNull(),
    mode: text().notNull(),
    partitionKey: text('partition_key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true, mode: 'date' }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text().default('pending').notNull(),
    sourceSnapshot: jsonb('source_snapshot').default([]).notNull(),
    sourceSnapshotRevision: text('source_snapshot_revision'),
    skillSha: text('skill_sha'),
    adapterVersion: text('adapter_version'),
    xCallCount: integer('x_call_count').default(0).notNull(),
    traceVerified: boolean('trace_verified').default(false).notNull(),
    checkpointAdvanced: boolean('checkpoint_advanced').default(false).notNull(),
    errorSummary: text('error_summary'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_acquisition_runs_idempotency_key').on(table.idempotencyKey),
    index('content_acquisition_runs_group_created_idx').on(table.groupId, table.createdAt),
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

export const contentSourceReceipts = content.table(
  'source_receipts',
  {
    receiptId: uuid('receipt_id').primaryKey().notNull(),
    runId: uuid('run_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    externalId: text('external_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    payload: jsonb().default({}).notNull(),
    canonicalHash: text('canonical_hash').notNull(),
    rightsPolicy: jsonb('rights_policy').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    unique('content_source_receipts_source_external_key').on(table.sourceId, table.externalId),
    index('content_source_receipts_run_idx').on(table.runId, table.capturedAt),
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
