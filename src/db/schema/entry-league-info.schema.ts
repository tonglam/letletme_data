import { pgTable, integer, text, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { autoIncrementId, createdAtField } from 'schema/_helpers.schema';
import { entryInfos } from 'schema/entry-info.schema';
import { leagueTypeEnum } from 'schema/enums.schema';
import { events } from 'schema/event.schema';

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
