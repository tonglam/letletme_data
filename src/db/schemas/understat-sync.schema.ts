import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtField, timestamps } from './_helpers.schema';
import {
  understatLaneEnum,
  understatSyncItemStatusEnum,
  understatSyncModeEnum,
  understatSyncRunStatusEnum,
  understatSyncTriggerEnum,
} from './enums.schema';
import { understatSeasons } from './understat-provider.schema';

export const understatSyncRuns = pgTable(
  'understat_sync_runs',
  {
    runId: uuid('run_id').primaryKey(),
    lane: understatLaneEnum('lane').notNull(),
    season: text('season')
      .notNull()
      .references(() => understatSeasons.season),
    mode: understatSyncModeEnum('mode').notNull(),
    trigger: understatSyncTriggerEnum('trigger').notNull(),
    status: understatSyncRunStatusEnum('status').notNull(),
    expectedItems: integer('expected_items').default(0).notNull(),
    completedItems: integer('completed_items').default(0).notNull(),
    failedItems: integer('failed_items').default(0).notNull(),
    skippedItems: integer('skipped_items').default(0).notNull(),
    dataChanged: boolean('data_changed').default(false).notNull(),
    cacheRevision: text('cache_revision'),
    publicationSkipReason: text('publication_skip_reason'),
    errorSummary: text('error_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('idx_understat_sync_runs_lane_season_started').on(
      table.lane,
      table.season,
      table.startedAt,
    ),
    index('idx_understat_sync_runs_status').on(table.status),
  ],
);

export const understatSyncItems = pgTable(
  'understat_sync_items',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => understatSyncRuns.runId),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    status: understatSyncItemStatusEnum('status').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    sourceHash: text('source_hash'),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...createdAtField,
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.resourceType, table.resourceId] }),
    index('idx_understat_sync_items_run_status').on(table.runId, table.status),
  ],
);

export type DbUnderstatSyncRun = typeof understatSyncRuns.$inferSelect;
export type DbUnderstatSyncItem = typeof understatSyncItems.$inferSelect;
