import { index, integer, jsonb, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import { chipEnum } from './enums.schema';
import { autoIncrementId, timestamps } from './_helpers.schema';
import { entryInfos } from './entry-infos.schema';
import { events } from './events.schema';
import { players } from './players.schema';

export const entryEventResults = pgTable(
  'entry_event_results',
  {
    ...autoIncrementId,
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    eventPoints: integer('event_points').default(0).notNull(),
    eventTransfers: integer('event_transfers').default(0).notNull(),
    eventTransfersCost: integer('event_transfers_cost').default(0).notNull(),
    eventNetPoints: integer('event_net_points').default(0).notNull(),
    eventBenchPoints: integer('event_bench_points'),
    eventAutoSubPoints: integer('event_auto_sub_points'),
    eventRank: integer('event_rank'),
    eventChip: chipEnum('event_chip'),
    eventPlayedCaptain: integer('event_played_captain').references(() => players.id),
    eventCaptainPoints: integer('event_captain_points'),
    eventPicks: jsonb('event_picks'),
    eventAutoSub: jsonb('event_auto_sub'),
    overallPoints: integer('overall_points').default(0).notNull(),
    overallRank: integer('overall_rank').default(0).notNull(),
    teamValue: integer('team_value'),
    bank: integer('bank'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_entry_event_result').on(table.entryId, table.eventId),
    index('idx_entry_event_results_entry_id').on(table.entryId),
    index('idx_entry_event_results_event_id').on(table.eventId),
  ],
);

export type DbEntryEventResult = Readonly<typeof entryEventResults.$inferSelect>;
export type DbEntryEventResults = readonly DbEntryEventResult[];

export type DbEntryEventResultInsert = Readonly<typeof entryEventResults.$inferInsert>;
export type DbEntryEventResultInserts = readonly DbEntryEventResultInsert[];
