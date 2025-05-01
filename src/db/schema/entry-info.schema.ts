import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { createdAtField } from 'schema/_helpers.schema';
import { events } from 'schema/event.schema';

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
