import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

import { createdAtField, timestamps } from './_helpers.schema';
import { fplSeasonArchiveStatusEnum } from './enums.schema';

export const fplSeasonArchives = pgTable(
  'fpl_season_archives',
  {
    season: text('season').primaryKey(),
    status: fplSeasonArchiveStatusEnum('status').notNull(),
    reason: text('reason'),
    sourceCoreRevision: text('source_core_revision'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorSummary: text('error_summary'),
    ...timestamps,
  },
  (table) => [
    check('fpl_season_archives_season_check', sql`${table.season} ~ '^[0-9]{4}$'`),
    check(
      'fpl_season_archives_unavailable_reason_check',
      sql`${table.status} <> 'unavailable' OR ${table.reason} IS NOT NULL`,
    ),
  ],
);

export const fplSeasonArchiveItems = pgTable(
  'fpl_season_archive_items',
  {
    season: text('season')
      .notNull()
      .references(() => fplSeasonArchives.season),
    sourceTable: text('source_table').notNull(),
    archiveTable: text('archive_table').notNull(),
    rowCount: bigint('row_count', { mode: 'number' }).notNull(),
    canonicalChecksum: text('canonical_checksum').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    ...createdAtField,
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.season, table.sourceTable] }),
    index('idx_fpl_archive_items_verified').on(table.season, table.verifiedAt),
    check('fpl_season_archive_items_row_count_check', sql`${table.rowCount} >= 0`),
  ],
);

export type DbFplSeasonArchive = typeof fplSeasonArchives.$inferSelect;
export type DbFplSeasonArchiveItem = typeof fplSeasonArchiveItems.$inferSelect;
