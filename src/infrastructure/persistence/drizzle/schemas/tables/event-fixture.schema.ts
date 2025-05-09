import { createdAtField } from '@app/schemas/_helpers.schema';
import { events } from '@app/schemas/event.schema';
import { teams } from '@app/schemas/team.schema';
import { boolean, index, integer, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const eventFixtures = pgTable(
  'event_fixtures',
  {
    id: integer('id').primaryKey(),
    code: integer('code').notNull().unique(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    kickoffTime: timestamp('kickoff_time', { withTimezone: true }),
    started: boolean('started').default(false).notNull(),
    finished: boolean('finished').default(false).notNull(),
    minutes: integer('minutes').default(0).notNull(),
    teamHId: integer('team_h_id')
      .notNull()
      .references(() => teams.id),
    teamHDifficulty: integer('team_h_difficulty'),
    teamHScore: integer('team_h_score'),
    teamAId: integer('team_a_id')
      .notNull()
      .references(() => teams.id),
    teamADifficulty: integer('team_a_difficulty'),
    teamAScore: integer('team_a_score'),
    ...createdAtField,
  },
  (table) => [
    uniqueIndex('uq_event_fixtures').on(table.eventId, table.teamHId, table.teamAId),
    index('idx_event_fixtures_event_id').on(table.eventId),
    index('idx_event_fixtures_team_h_id').on(table.teamHId),
    index('idx_event_fixtures_team_a_id').on(table.teamAId),
  ],
);

export type DbEventFixture = Readonly<typeof eventFixtures.$inferSelect>;
export type DbEventFixtures = readonly DbEventFixture[];

export type DbEventFixtureInsert = Readonly<typeof eventFixtures.$inferInsert>;
export type DbEventFixtureInserts = readonly DbEventFixtureInsert[];
