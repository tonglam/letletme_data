import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { leagueTypeEnum } from './enums.schema';
import { autoIncrementId, createdAtField } from './_helpers.schema';
import { entryInfos } from './entry-infos.schema';
import { events } from './events.schema';

export const entryLeagueInfos = pgTable(
  'entry_league_infos',
  {
    ...autoIncrementId,
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    leagueId: integer('league_id').notNull(),
    leagueName: text('league_name').notNull(),
    leagueType: leagueTypeEnum('league_type').notNull(),
    startedEvent: integer('started_event').references(() => events.id),
    entryRank: integer('entry_rank'),
    entryLastRank: integer('entry_last_rank'),
    ...createdAtField,
  },
  (table) => [
    uniqueIndex('unique_entry_league_info').on(table.entryId, table.leagueId),
    index('idx_entry_league_info_entry_id').on(table.entryId),
  ],
);

export type DbEntryLeagueInfo = Readonly<typeof entryLeagueInfos.$inferSelect>;
export type DbEntryLeagueInfos = readonly DbEntryLeagueInfo[];

export type DbEntryLeagueInfoInsert = Readonly<typeof entryLeagueInfos.$inferInsert>;
export type DbEntryLeagueInfoInserts = readonly DbEntryLeagueInfoInsert[];
