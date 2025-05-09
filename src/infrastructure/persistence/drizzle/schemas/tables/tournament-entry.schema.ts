import { autoIncrementId, createdAtField } from '@app/schemas/_helpers.schema';
import { entryInfos } from '@app/schemas/entry-info.schema';
import { tournamentInfos } from '@app/schemas/tournament-info.schema';
import { index, integer, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';

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

export type DbTournamentEntry = Readonly<typeof tournamentEntries.$inferSelect>;
export type DbTournamentEntries = readonly DbTournamentEntry[];

export type DbTournamentEntryInsert = Readonly<typeof tournamentEntries.$inferInsert>;
export type DbTournamentEntryInserts = readonly DbTournamentEntryInsert[];
