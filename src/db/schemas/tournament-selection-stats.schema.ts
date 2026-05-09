import { index, integer, pgTable, primaryKey } from 'drizzle-orm/pg-core';
import { timestamps } from './_helpers.schema';
import { events } from './events.schema';
import { players } from './players.schema';
import { tournamentInfos } from './tournament-infos.schema';

export const tournamentSelectionStats = pgTable(
  'tournament_selection_stats',
  {
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournamentInfos.id, { onDelete: 'cascade' }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    elementId: integer('element_id')
      .notNull()
      .references(() => players.id),
    pickCount: integer('pick_count').default(0).notNull(),
    captainCount: integer('captain_count').default(0).notNull(),
    viceCaptainCount: integer('vice_captain_count').default(0).notNull(),
    transferInCount: integer('transfer_in_count').default(0).notNull(),
    transferOutCount: integer('transfer_out_count').default(0).notNull(),
    totalEntries: integer('total_entries').default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      name: 'tournament_selection_stats_pkey',
      columns: [table.tournamentId, table.eventId, table.elementId],
    }),
    index('idx_tournament_selection_stats_tournament_event').on(table.tournamentId, table.eventId),
    index('idx_tournament_selection_stats_pick_count').on(
      table.tournamentId,
      table.eventId,
      table.pickCount.desc(),
    ),
    index('idx_tournament_selection_stats_captain_count').on(
      table.tournamentId,
      table.eventId,
      table.captainCount.desc(),
    ),
    index('idx_tournament_selection_stats_vice_captain_count').on(
      table.tournamentId,
      table.eventId,
      table.viceCaptainCount.desc(),
    ),
    index('idx_tournament_selection_stats_transfer_in_count').on(
      table.tournamentId,
      table.eventId,
      table.transferInCount.desc(),
    ),
    index('idx_tournament_selection_stats_transfer_out_count').on(
      table.tournamentId,
      table.eventId,
      table.transferOutCount.desc(),
    ),
  ],
);

export type DbTournamentSelectionStat = Readonly<typeof tournamentSelectionStats.$inferSelect>;
export type DbTournamentSelectionStats = readonly DbTournamentSelectionStat[];

export type DbTournamentSelectionStatInsert = Readonly<
  typeof tournamentSelectionStats.$inferInsert
>;
export type DbTournamentSelectionStatInserts = readonly DbTournamentSelectionStatInsert[];
