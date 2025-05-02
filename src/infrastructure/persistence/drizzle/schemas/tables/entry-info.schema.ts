import { createdAtField } from '@app/schemas/_helpers.schema';
import { events } from '@app/schemas/event.schema';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

export const entryInfos = pgTable('entry_infos', {
  id: integer('id').primaryKey(),
  entryName: text('entry_name').notNull(),
  playerName: text('player_name').notNull(),
  region: text('region'),
  startedEvent: integer('started_event').references(() => events.id),
  overallPoints: integer('overall_points'),
  overallRank: integer('overall_rank'),
  bank: integer('bank'),
  teamValue: integer('team_value'),
  totalTransfers: integer('total_transfers'),
  lastEntryName: text('last_entry_name'),
  lastOverallPoints: integer('last_overall_points'),
  lastOverallRank: integer('last_overall_rank'),
  lastTeamValue: integer('last_team_value'),
  usedEntryNames: text('used_entry_names').array().default([]),
  ...createdAtField,
});

export type EntryInfo = Readonly<typeof entryInfos.$inferSelect>;
export type EntryInfos = readonly EntryInfo[];

export type EntryInfoCreateInput = Readonly<typeof entryInfos.$inferInsert>;
export type EntryInfoCreateInputs = readonly EntryInfoCreateInput[];
