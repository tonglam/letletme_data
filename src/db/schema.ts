import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Events table
export const events = pgTable('events', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  deadlineTime: timestamp('deadline_time'),
  averageEntryScore: integer('average_entry_score'),
  finished: boolean('finished').notNull().default(false),
  dataChecked: boolean('data_checked').notNull().default(false),
  highestScoringEntry: integer('highest_scoring_entry'),
  deadlineTimeEpoch: integer('deadline_time_epoch'),
  deadlineTimeGameOffset: integer('deadline_time_game_offset'),
  highestScore: integer('highest_score'),
  isPrevious: boolean('is_previous').notNull().default(false),
  isCurrent: boolean('is_current').notNull().default(false),
  isNext: boolean('is_next').notNull().default(false),
  cupLeagueCreate: boolean('cup_league_create').notNull().default(false),
  h2hKoMatchesCreated: boolean('h2h_ko_matches_created').notNull().default(false),
  chipPlays: jsonb('chip_plays').$type<unknown[]>().default([]),
  mostSelected: integer('most_selected'),
  mostTransferredIn: integer('most_transferred_in'),
  topElement: integer('top_element'),
  topElementInfo: jsonb('top_element_info'),
  transfersMade: integer('transfers_made'),
  mostCaptained: integer('most_captained'),
  mostViceCaptained: integer('most_vice_captained'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Teams table
export const teams = pgTable('teams', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),
  code: integer('code').notNull(),
  draw: integer('draw').notNull().default(0),
  form: text('form'),
  loss: integer('loss').notNull().default(0),
  played: integer('played').notNull().default(0),
  points: integer('points').notNull().default(0),
  position: integer('position').notNull(),
  strength: integer('strength').notNull(),
  teamDivision: integer('team_division'),
  unavailable: boolean('unavailable').notNull().default(false),
  win: integer('win').notNull().default(0),
  strengthOverallHome: integer('strength_overall_home').notNull(),
  strengthOverallAway: integer('strength_overall_away').notNull(),
  strengthAttackHome: integer('strength_attack_home').notNull(),
  strengthAttackAway: integer('strength_attack_away').notNull(),
  strengthDefenceHome: integer('strength_defence_home').notNull(),
  strengthDefenceAway: integer('strength_defence_away').notNull(),
  pulseId: integer('pulse_id').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Phases table
export const phases = pgTable('phases', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  startEvent: integer('start_event').notNull(),
  stopEvent: integer('stop_event').notNull(),
  highestScore: integer('highest_score'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Players table
export const players = pgTable('players', {
  id: integer('id').primaryKey(),
  code: integer('code').notNull(),
  type: integer('type').notNull(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  price: integer('price').notNull(),
  startPrice: integer('start_price').notNull(),
  firstName: text('first_name').notNull(),
  secondName: text('second_name').notNull(),
  webName: text('web_name').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Export types
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type Phase = typeof phases.$inferSelect;
export type NewPhase = typeof phases.$inferInsert;
export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
