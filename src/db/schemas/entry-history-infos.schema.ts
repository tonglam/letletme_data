import { char, index, integer, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import { autoIncrementId, createdAtField } from './_helpers.schema';
import { entryInfos } from './entry-infos.schema';

export const entryHistoryInfos = pgTable(
  'entry_history_infos',
  {
    ...autoIncrementId,
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    season: char('season', { length: 4 }).notNull(),
    totalPoints: integer('total_points').default(0).notNull(),
    overallRank: integer('overall_rank').default(0).notNull(),
    ...createdAtField,
  },
  (table) => [
    uniqueIndex('unique_entry_history_info').on(table.entryId, table.season),
    index('idx_entry_history_info_entry_id').on(table.entryId),
  ],
);

export type DbEntryHistoryInfo = Readonly<typeof entryHistoryInfos.$inferSelect>;
export type DbEntryHistoryInfos = readonly DbEntryHistoryInfo[];

export type DbEntryHistoryInfoInsert = Readonly<typeof entryHistoryInfos.$inferInsert>;
export type DbEntryHistoryInfoInserts = readonly DbEntryHistoryInfoInsert[];
