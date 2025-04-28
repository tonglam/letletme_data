import { pgTable, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { autoIncrementId, createdAtField } from 'schema/_helpers';
import { entryInfos } from 'schema/entry-info';
import { tournamentInfos } from 'schema/tournament-info';

export const tournamentEntries = pgTable(
  'tournament_entries',
  {
    ...autoIncrementId,
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournamentInfos.id),
    leagueId: integer('league_id').notNull(),
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    ...createdAtField,
  },
  (table) => [
    uniqueIndex('unique_tournament_entry').on(table.tournamentId, table.leagueId, table.entryId),
    index('idx_tournament_entry_tournament_id').on(table.tournamentId),
  ],
);
