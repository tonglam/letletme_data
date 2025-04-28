import { pgTable, integer, char, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { autoIncrementId, createdAtField } from 'schema/_helpers';
import { entryInfos } from 'schema/entry-info';

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
    uniqueIndex('unique_entry_season_history').on(table.entryId, table.season),
    index('idx_entry_history_info_entry_id').on(table.entryId),
  ],
);
