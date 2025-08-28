import { index, integer, jsonb, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import { chipEnum } from 'enums.schema';
import { autoIncrementId, createdAtField } from './_helpers.schema';
import { entryInfos } from './entry-infos.schema';
import { events } from './events.schema';

export const entryEventPicks = pgTable(
  'entry_event_picks',
  {
    ...autoIncrementId,
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    chip: chipEnum('chip').notNull(),
    picks: jsonb('picks'),
    transfers: integer('transfers'),
    transfersCost: integer('transfers_cost'),
    ...createdAtField,
  },
  (table) => [
    uniqueIndex('unique_entry_event_pick').on(table.entryId, table.eventId),
    index('idx_entry_event_picks_entry_id').on(table.entryId),
  ],
);

export type DbEntryEventPick = Readonly<typeof entryEventPicks.$inferSelect>;
export type DbEntryEventPicks = readonly DbEntryEventPick[];

export type DbEntryEventPickInsert = Readonly<typeof entryEventPicks.$inferInsert>;
export type DbEntryEventPickInserts = readonly DbEntryEventPickInsert[];
