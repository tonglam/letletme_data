import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamps } from './_helpers.schema';
import { events } from './events.schema';
import { teams } from './teams.schema';

export const eventFixtures = pgTable(
  'event_fixtures',
  {
    id: integer('id').primaryKey(),
    code: integer('code').notNull().unique(),
    eventId: integer('event_id').references(() => events.id),
    finished: boolean('finished').default(false).notNull(),
    finishedProvisional: boolean('finished_provisional').default(false).notNull(),
    kickoffTime: timestamp('kickoff_time', { withTimezone: true }),
    minutes: integer('minutes').default(0).notNull(),
    provisionalStartTime: boolean('provisional_start_time').default(false).notNull(),
    started: boolean('started'),
    teamAId: integer('team_a_id')
      .notNull()
      .references(() => teams.id),
    teamAScore: integer('team_a_score'),
    teamHId: integer('team_h_id')
      .notNull()
      .references(() => teams.id),
    teamHScore: integer('team_h_score'),
    stats: jsonb('stats')
      .$type<
        Array<{
          identifier: string;
          a: Array<{ value: number; element: number }>;
          h: Array<{ value: number; element: number }>;
        }>
      >()
      .default([])
      .notNull(),
    teamHDifficulty: integer('team_h_difficulty'),
    teamADifficulty: integer('team_a_difficulty'),
    pulseId: integer('pulse_id').notNull(),
    ...timestamps,
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
