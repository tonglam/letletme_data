import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { timestamps } from './_helpers.schema';
import { events } from './events.schema';

export const entryInfos = pgTable('entry_infos', {
  id: integer('id').primaryKey(),
  entryName: text('entry_name').notNull(),
  playerName: text('player_name').notNull(),
  region: text('region'),
  startedEvent: integer('started_event').references(() => events.id),
  overallPoints: integer('overall_points'),
  overallRank: integer('overall_rank'),
  bank: integer('bank'),
  lastBank: integer('last_bank'),
  teamValue: integer('team_value'),
  totalTransfers: integer('total_transfers'),
  lastEntryName: text('last_entry_name'),
  lastOverallPoints: integer('last_overall_points'),
  lastOverallRank: integer('last_overall_rank'),
  lastTeamValue: integer('last_team_value'),
  usedEntryNames: text('used_entry_names').array().default([]),
  ...timestamps,
});

export type DbEntryInfo = Readonly<typeof entryInfos.$inferSelect>;
export type DbEntryInfos = readonly DbEntryInfo[];

export type DbEntryInfoInsert = Readonly<typeof entryInfos.$inferInsert>;
export type DbEntryInfoInserts = readonly DbEntryInfoInsert[];
