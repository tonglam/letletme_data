import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { autoIncrementId, timestamps } from './_helpers.schema';
import { events } from './events.schema';
import { players } from './players.schema';

export const playerStats = pgTable(
  'player_stats',
  {
    ...autoIncrementId,
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    elementId: integer('element_id')
      .notNull()
      .references(() => players.id),
    elementType: integer('element_type').notNull(),
    totalPoints: integer('total_points'),
    form: text('form'),
    influence: text('influence'),
    creativity: text('creativity'),
    threat: text('threat'),
    ictIndex: text('ict_index'),
    expectedGoals: text('expected_goals'),
    expectedAssists: text('expected_assists'),
    expectedGoalInvolvements: text('expected_goal_involvements'),
    expectedGoalsConceded: text('expected_goals_conceded'),
    minutes: integer('minutes'),
    goalsScored: integer('goals_scored'),
    assists: integer('assists'),
    cleanSheets: integer('clean_sheets'),
    goalsConceded: integer('goals_conceded'),
    ownGoals: integer('own_goals'),
    penaltiesSaved: integer('penalties_saved'),
    yellowCards: integer('yellow_cards').default(0),
    redCards: integer('red_cards').default(0),
    saves: integer('saves').default(0),
    bonus: integer('bonus').default(0),
    bps: integer('bps').default(0),
    starts: integer('starts').default(0),
    influenceRank: integer('influence_rank'),
    influenceRankType: integer('influence_rank_type'),
    creativityRank: integer('creativity_rank'),
    creativityRankType: integer('creativity_rank_type'),
    threatRank: integer('threat_rank'),
    threatRankType: integer('threat_rank_type'),
    ictIndexRank: integer('ict_index_rank'),
    ictIndexRankType: integer('ict_index_rank_type'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_player_stats').on(table.eventId, table.elementId),
    index('idx_player_stats_element_id').on(table.elementId),
    index('idx_player_stats_event_id').on(table.eventId),
  ],
);

export type DbPlayerStat = Readonly<typeof playerStats.$inferSelect>;
export type DbPlayerStats = readonly DbPlayerStat[];

export type DbPlayerStatInsert = Readonly<typeof playerStats.$inferInsert>;
export type DbPlayerStatInserts = readonly DbPlayerStatInsert[];
