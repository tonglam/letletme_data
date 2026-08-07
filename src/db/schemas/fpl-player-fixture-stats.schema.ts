import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { autoIncrementId, timestamps } from './_helpers.schema';

export const fplPlayerFixtureStats = pgTable(
  'fpl_player_fixture_stats',
  {
    ...autoIncrementId,
    season: text('season').notNull(),
    eventId: integer('event_id').notNull(),
    fixtureId: integer('fixture_id').notNull(),
    fixtureCode: integer('fixture_code').notNull(),
    elementId: integer('element_id').notNull(),
    playerCode: integer('player_code').notNull(),
    teamId: integer('team_id').notNull(),
    teamCode: integer('team_code').notNull(),
    elementType: integer('element_type').notNull(),
    minutes: integer('minutes').notNull(),
    starts: integer('starts').notNull(),
    goals: integer('goals').notNull(),
    assists: integer('assists').notNull(),
    ownGoals: integer('own_goals').notNull(),
    yellowCards: integer('yellow_cards').notNull(),
    redCards: integer('red_cards').notNull(),
    sourceHash: text('source_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    check('fpl_player_fixture_stats_season_check', sql`${table.season} ~ '^[0-9]{4}$'`),
    check('fpl_player_fixture_stats_element_type_check', sql`${table.elementType} BETWEEN 1 AND 4`),
    check(
      'fpl_player_fixture_stats_nonnegative_check',
      sql`${table.minutes} >= 0 AND ${table.starts} BETWEEN 0 AND 1
        AND ${table.goals} >= 0 AND ${table.assists} >= 0 AND ${table.ownGoals} >= 0
        AND ${table.yellowCards} >= 0 AND ${table.redCards} >= 0`,
    ),
    uniqueIndex('uq_fpl_player_fixture_stats').on(table.season, table.fixtureId, table.playerCode),
    index('idx_fpl_player_fixture_stats_player').on(
      table.season,
      table.playerCode,
      table.fixtureId,
    ),
    index('idx_fpl_player_fixture_stats_fixture').on(table.season, table.fixtureId),
  ],
);

export type DbFplPlayerFixtureStat = typeof fplPlayerFixtureStats.$inferSelect;
export type DbFplPlayerFixtureStatInsert = typeof fplPlayerFixtureStats.$inferInsert;
