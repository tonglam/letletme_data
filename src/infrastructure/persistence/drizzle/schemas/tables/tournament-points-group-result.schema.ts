import { autoIncrementId, timestamps } from '@app/schemas/_helpers.schema';
import { entryInfos } from '@app/schemas/entry-info.schema';
import { events } from '@app/schemas/event.schema';
import { tournamentInfos } from '@app/schemas/tournament-info.schema';
import { index, integer, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';

export const tournamentPointsGroupResults = pgTable(
  'tournament_points_group_results',
  {
    ...autoIncrementId,
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournamentInfos.id),
    groupId: integer('group_id').notNull(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    eventGroupRank: integer('event_group_rank'),
    eventPoints: integer('event_points'),
    eventCost: integer('event_cost'),
    eventNetPoints: integer('event_net_points'),
    eventRank: integer('event_rank'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_tournament_points_group_result').on(
      table.tournamentId,
      table.groupId,
      table.eventId,
      table.entryId,
    ),
    index('idx_tournament_points_group_result_tournament_id').on(table.tournamentId),
    index('idx_tournament_points_group_result_group_id').on(table.groupId),
    index('idx_tournament_points_group_result_event_id').on(table.eventId),
    index('idx_tournament_points_group_result_entry_id').on(table.entryId),
  ],
);

export type DbTournamentPointsGroupResult = Readonly<
  typeof tournamentPointsGroupResults.$inferSelect
>;
export type DbTournamentPointsGroupResults = readonly DbTournamentPointsGroupResult[];

export type DbTournamentPointsGroupResultInsert = Readonly<
  typeof tournamentPointsGroupResults.$inferInsert
>;
export type DbTournamentPointsGroupResultInserts = readonly DbTournamentPointsGroupResultInsert[];
