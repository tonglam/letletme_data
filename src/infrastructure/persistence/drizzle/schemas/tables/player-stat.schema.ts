import { autoIncrementId, timestamps } from '@app/schemas/_helpers.schema';
import { events } from '@app/schemas/event.schema';
import { players } from '@app/schemas/player.schema';
import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

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
    mngWin: integer('mng_win'),
    mngDraw: integer('mng_draw'),
    mngLoss: integer('mng_loss'),
    mngUnderdogWin: integer('mng_underdog_win'),
    mngUnderdogDraw: integer('mng_underdog_draw'),
    mngCleanSheets: integer('mng_clean_sheets'),
    mngGoalsScored: integer('mng_goals_scored'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_player_stats').on(table.eventId, table.elementId),
    index('idx_player_stats_element_id').on(table.elementId),
    index('idx_player_stats_event_id').on(table.eventId),
  ],
);

export type PlayerStat = Readonly<typeof playerStats.$inferSelect>;
export type PlayerStats = readonly PlayerStat[];

export type PlayerStatCreateInput = Readonly<typeof playerStats.$inferInsert>;
export type PlayerStatCreateInputs = readonly PlayerStatCreateInput[];
