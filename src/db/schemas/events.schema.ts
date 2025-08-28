import { boolean, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createdAtField } from './_helpers.schema';

export const events = pgTable('events', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  deadlineTime: timestamp('deadline_time'),
  averageEntryScore: integer('average_entry_score'),
  finished: boolean('finished').default(false).notNull(),
  dataChecked: boolean('data_checked').default(false).notNull(),
  highestScoringEntry: integer('highest_scoring_entry'),
  deadlineTimeEpoch: integer('deadline_time_epoch'),
  deadlineTimeGameOffset: integer('deadline_time_game_offset'),
  highestScore: integer('highest_score'),
  isPrevious: boolean('is_previous').default(false).notNull(),
  isCurrent: boolean('is_current').default(false).notNull(),
  isNext: boolean('is_next').default(false).notNull(),
  cupLeagueCreate: boolean('cup_league_create').default(false).notNull(),
  h2hKoMatchesCreated: boolean('h2h_ko_matches_created').default(false).notNull(),
  chipPlays: jsonb('chip_plays').default('[]'),
  mostSelected: integer('most_selected'),
  mostTransferredIn: integer('most_transferred_in'),
  topElement: integer('top_element'),
  topElementInfo: jsonb('top_element_info'),
  transfersMade: integer('transfers_made'),
  mostCaptained: integer('most_captained'),
  mostViceCaptained: integer('most_vice_captained'),
  ...createdAtField,
});

export type DbEvent = Readonly<typeof events.$inferSelect>;
export type DbEvents = readonly DbEvent[];

export type DbEventInsert = Readonly<typeof events.$inferInsert>;
export type DbEventInserts = readonly DbEventInsert[];
