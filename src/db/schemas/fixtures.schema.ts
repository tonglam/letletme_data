import { boolean, integer, jsonb, pgTable, timestamp } from 'drizzle-orm/pg-core';
import { timestamps } from './_helpers.schema';

export const fixtures = pgTable('fixtures', {
  id: integer('id').primaryKey(),
  code: integer('code').notNull(),
  event: integer('event'),
  finished: boolean('finished').default(false).notNull(),
  finishedProvisional: boolean('finished_provisional').default(false).notNull(),
  kickoffTime: timestamp('kickoff_time'),
  minutes: integer('minutes').default(0).notNull(),
  provisionalStartTime: boolean('provisional_start_time').default(false).notNull(),
  started: boolean('started'),
  teamA: integer('team_a').notNull(),
  teamAScore: integer('team_a_score'),
  teamH: integer('team_h').notNull(),
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
});

export type DbFixture = Readonly<typeof fixtures.$inferSelect>;
export type DbFixtures = readonly DbFixture[];

export type DbFixtureInsert = Readonly<typeof fixtures.$inferInsert>;
export type DbFixtureInserts = readonly DbFixtureInsert[];
