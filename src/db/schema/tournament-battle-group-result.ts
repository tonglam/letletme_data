import { pgTable, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { autoIncrementId, timestamps } from 'schema/_helpers';
import { entryInfos } from 'schema/entry-info';
import { events } from 'schema/event';
import { tournamentInfos } from 'schema/tournament-info';

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
