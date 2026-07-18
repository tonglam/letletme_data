import { index, integer, numeric, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
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
    form: numeric('form', { precision: 10, scale: 2, mode: 'number' }),
    influence: text('influence'),
    creativity: text('creativity'),
    threat: text('threat'),
    ictIndex: numeric('ict_index', { precision: 10, scale: 2, mode: 'number' }),
    expectedGoals: numeric('expected_goals', { precision: 10, scale: 2, mode: 'number' }),
    expectedAssists: numeric('expected_assists', { precision: 10, scale: 2, mode: 'number' }),
    expectedGoalInvolvements: numeric('expected_goal_involvements', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }),
    expectedGoalsConceded: numeric('expected_goals_conceded', {
      precision: 10,
      scale: 2,
      mode: 'number',
    }),
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
    transfersIn: integer('transfers_in'),
    transfersInEvent: integer('transfers_in_event'),
    transfersOut: integer('transfers_out'),
    transfersOutEvent: integer('transfers_out_event'),
    influenceRank: integer('influence_rank'),
    influenceRankType: integer('influence_rank_type'),
    creativityRank: integer('creativity_rank'),
    creativityRankType: integer('creativity_rank_type'),
    threatRank: integer('threat_rank'),
    threatRankType: integer('threat_rank_type'),
    ictIndexRank: integer('ict_index_rank'),
    ictIndexRankType: integer('ict_index_rank_type'),
    selectedByPercent: text('selected_by_percent'),
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
