import { autoIncrementId, timestamps } from '@app/schemas/_helpers.schema';
import { entryInfos } from '@app/schemas/entry-info.schema';
import { events } from '@app/schemas/event.schema';
import { tournamentInfos } from '@app/schemas/tournament-info.schema';
import { index, integer, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';

export const tournamentBattleGroupResults = pgTable(
  'tournament_battle_group_results',
  {
    ...autoIncrementId,
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournamentInfos.id),
    groupId: integer('group_id').notNull(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    homeIndex: integer('home_index').notNull(),
    homeEntryId: integer('home_entry_id')
      .notNull()
      .references(() => entryInfos.id),
    homeNetPoints: integer('home_net_points'),
    homeRank: integer('home_rank'),
    homeMatchPoints: integer('home_match_points'),
    awayIndex: integer('away_index').notNull(),
    awayEntryId: integer('away_entry_id')
      .notNull()
      .references(() => entryInfos.id),
    awayNetPoints: integer('away_net_points'),
    awayRank: integer('away_rank'),
    awayMatchPoints: integer('away_match_points'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_tournament_battle_group_result').on(
      table.tournamentId,
      table.groupId,
      table.eventId,
      table.homeIndex,
      table.awayIndex,
    ),
    index('idx_tournament_battle_group_result_tournament_id').on(table.tournamentId),
    index('idx_tournament_battle_group_result_group_id').on(table.groupId),
    index('idx_tournament_battle_group_result_event_id').on(table.eventId),
  ],
);

export type TournamentBattleGroupResult = Readonly<
  typeof tournamentBattleGroupResults.$inferSelect
>;
export type TournamentBattleGroupResults = readonly TournamentBattleGroupResult[];

export type TournamentBattleGroupResultCreateInput = Readonly<
  typeof tournamentBattleGroupResults.$inferInsert
>;
export type TournamentBattleGroupResultCreateInputs =
  readonly TournamentBattleGroupResultCreateInput[];
