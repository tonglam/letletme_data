import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { autoIncrementId, createdAtField } from './_helpers.schema';
import { entryInfos } from './entry-infos.schema';
import { events } from './events.schema';
import { tournamentInfos } from './tournament-infos.schema';

export const tournamentGroups = pgTable(
  'tournament_groups',
  {
    ...autoIncrementId,
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournamentInfos.id),
    groupId: integer('group_id').notNull(),
    groupName: text('group_name').notNull(),
    groupIndex: integer('group_index').notNull(),
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    startedEventId: integer('started_event_id').references(() => events.id),
    endedEventId: integer('ended_event_id').references(() => events.id),
    groupPoints: integer('group_points'),
    groupRank: integer('group_rank'),
    played: integer('played'),
    won: integer('won'),
    drawn: integer('drawn'),
    lost: integer('lost'),
    totalPoints: integer('total_points'),
    totalTransfersCost: integer('total_transfers_cost'),
    totalNetPoints: integer('total_net_points'),
    qualified: integer('qualified'),
    overallRank: integer('overall_rank'),
    ...createdAtField,
  },
  (table) => [
    uniqueIndex('unique_tournament_group').on(table.tournamentId, table.groupId, table.entryId),
    index('idx_tournament_group_tournament_id').on(table.tournamentId),
    index('idx_tournament_group_group_id').on(table.groupId),
  ],
);

export type DbTournamentGroup = Readonly<typeof tournamentGroups.$inferSelect>;
export type DbTournamentGroups = readonly DbTournamentGroup[];

export type DbTournamentGroupInsert = Readonly<typeof tournamentGroups.$inferInsert>;
export type DbTournamentGroupInserts = readonly DbTournamentGroupInsert[];
