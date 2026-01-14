import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { autoIncrementId, timestamps } from './_helpers.schema';
import { events } from './events.schema';
import { teams } from './teams.schema';

export const eventStandings = pgTable(
  'event_standings',
  {
    ...autoIncrementId,
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    position: integer('position').notNull(),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    teamName: text('team_name').notNull(),
    teamShortName: text('team_short_name').notNull(),
    points: integer('points').notNull(),
    played: integer('played').notNull(),
    won: integer('won').notNull(),
    drawn: integer('drawn').notNull(),
    lost: integer('lost').notNull(),
    goalsFor: integer('goals_for').notNull(),
    goalsAgainst: integer('goals_against').notNull(),
    goalsDifference: integer('goals_difference').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_event_standing').on(table.eventId, table.teamId),
    index('idx_event_standings_event_id').on(table.eventId),
    index('idx_event_standings_team_id').on(table.teamId),
  ],
);

export type DbEventStanding = Readonly<typeof eventStandings.$inferSelect>;
export type DbEventStandings = readonly DbEventStanding[];

export type DbEventStandingInsert = Readonly<typeof eventStandings.$inferInsert>;
export type DbEventStandingInserts = readonly DbEventStandingInsert[];
