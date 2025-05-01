import { pgTable, integer, text, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';
import { createdAtField } from 'schema/_helpers.schema';

export const events = pgTable('events', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  deadlineTime: timestamp('deadline_time', { withTimezone: true }).notNull(),
  averageEntryScore: integer('average_entry_score').default(0).notNull(),
  finished: boolean('finished').default(false).notNull(),
  dataChecked: boolean('data_checked').default(false).notNull(),
  highestScore: integer('highest_score').default(0).notNull(),
  highestScoringEntry: integer('highest_scoring_entry').default(0).notNull(),
  isPrevious: boolean('is_previous').default(false).notNull(),
  isCurrent: boolean('is_current').default(false).notNull(),
  isNext: boolean('is_next').default(false).notNull(),
  cupLeaguesCreated: boolean('cup_leagues_created').default(false).notNull(),
  h2hKoMatchesCreated: boolean('h2h_ko_matches_created').default(false).notNull(),
  rankedCount: integer('ranked_count').default(0).notNull(),
  chipPlays: jsonb('chip_plays'),
  mostSelected: integer('most_selected'),
  mostTransferredIn: integer('most_transferred_in'),
  mostCaptained: integer('most_captained'),
  mostViceCaptained: integer('most_vice_captained'),
  topElement: integer('top_element'),
  topElementInfo: jsonb('top_element_info'),
  transfersMade: integer('transfers_made').default(0).notNull(),
  ...createdAtField,
});
