import { pgTable, integer, decimal, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { autoIncrementId, createdAtField } from 'schema/_helpers';
import { events } from 'schema/event';
import { players } from 'schema/player';

export const eventLive = pgTable(
  'event_live',
  {
    ...autoIncrementId,
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    elementId: integer('element_id')
      .notNull()
      .references(() => players.id),
    minutes: integer('minutes'),
    goalsScored: integer('goals_scored'),
    assists: integer('assists'),
    cleanSheets: integer('clean_sheets'),
    goalsConceded: integer('goals_conceded'),
    ownGoals: integer('own_goals'),
    penaltiesSaved: integer('penalties_saved'),
    penaltiesMissed: integer('penalties_missed'),
    yellowCards: integer('yellow_cards'),
    redCards: integer('red_cards'),
    saves: integer('saves'),
    bonus: integer('bonus'),
    bps: integer('bps'),
    starts: boolean('starts'),
    expectedGoals: decimal('expected_goals', { precision: 10, scale: 2 }),
    expectedAssists: decimal('expected_assists', { precision: 10, scale: 2 }),
    expectedGoalInvolvements: decimal('expected_goal_involvements', {
      precision: 10,
      scale: 2,
    }),
    expectedGoalsConceded: decimal('expected_goals_conceded', {
      precision: 10,
      scale: 2,
    }),
    mngWin: integer('mng_win'),
    mngDraw: integer('mng_draw'),
    mngLoss: integer('mng_loss'),
    mngUnderdogWin: integer('mng_underdog_win'),
    mngUnderdogDraw: integer('mng_underdog_draw'),
    mngCleanSheets: integer('mng_clean_sheets'),
    mngGoalsScored: integer('mng_goals_scored'),
    inDreamTeam: boolean('in_dream_team'),
    totalPoints: integer('total_points').default(0).notNull(),
    ...createdAtField,
  },
  (table) => [
    uniqueIndex('unique_event_live').on(table.eventId, table.elementId),
    index('idx_event_live_element_id').on(table.elementId),
  ],
);
