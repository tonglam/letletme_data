import { index, integer, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';

import { autoIncrementId, timestamps } from './_helpers.schema';
import { events } from './events.schema';
import { players } from './players.schema';
import { teams } from './teams.schema';

export const eventLiveSummaries = pgTable(
  'event_live_summaries',
  {
    ...autoIncrementId,
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    elementId: integer('element_id')
      .notNull()
      .references(() => players.id),
    elementType: integer('element_type').notNull(),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    minutes: integer('minutes').default(0).notNull(),
    goalsScored: integer('goals_scored').default(0).notNull(),
    assists: integer('assists').default(0).notNull(),
    cleanSheets: integer('clean_sheets').default(0).notNull(),
    goalsConceded: integer('goals_conceded').default(0).notNull(),
    ownGoals: integer('own_goals').default(0).notNull(),
    penaltiesSaved: integer('penalties_saved').default(0).notNull(),
    penaltiesMissed: integer('penalties_missed').default(0).notNull(),
    yellowCards: integer('yellow_cards').default(0).notNull(),
    redCards: integer('red_cards').default(0).notNull(),
    saves: integer('saves').default(0).notNull(),
    bonus: integer('bonus').default(0).notNull(),
    bps: integer('bps').default(0).notNull(),
    totalPoints: integer('total_points').default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_event_live_summary_element').on(table.elementId),
    index('idx_event_live_summary_event_id').on(table.eventId),
  ],
);

export type DbEventLiveSummary = Readonly<typeof eventLiveSummaries.$inferSelect>;
export type DbEventLiveSummaries = readonly DbEventLiveSummary[];

export type DbEventLiveSummaryInsert = Readonly<typeof eventLiveSummaries.$inferInsert>;
export type DbEventLiveSummaryInserts = readonly DbEventLiveSummaryInsert[];
