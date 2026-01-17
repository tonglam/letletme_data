import { boolean, decimal, index, integer, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import { autoIncrementId, timestamps } from './_helpers.schema';
import { events } from './events.schema';
import { players } from './players.schema';

export const eventLive = pgTable(
  'event_lives',
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
    inDreamTeam: boolean('in_dream_team'),
    totalPoints: integer('total_points').default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_event_live').on(table.eventId, table.elementId),
    index('idx_event_live_element_id').on(table.elementId),
  ],
);

export type DbEventLive = Readonly<typeof eventLive.$inferSelect>;
export type DbEventLives = readonly DbEventLive[];

export type DbEventLiveInsert = Readonly<typeof eventLive.$inferInsert>;
export type DbEventLiveInserts = readonly DbEventLiveInsert[];
