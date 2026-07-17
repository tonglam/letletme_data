import { boolean, index, integer, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { autoIncrementId, timestamps } from './_helpers.schema';
import { entryInfos } from './entry-infos.schema';
import { events } from './events.schema';
import { players } from './players.schema';

export const entryEventTransfers = pgTable(
  'entry_event_transfers',
  {
    ...autoIncrementId,
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    elementInId: integer('element_in_id').references(() => players.id),
    elementInCost: integer('element_in_cost'),
    elementInPoints: integer('element_in_points'),
    elementInPlayed: boolean('element_in_played'),
    elementOutId: integer('element_out_id').references(() => players.id),
    elementOutCost: integer('element_out_cost'),
    elementOutPoints: integer('element_out_points'),
    transferTime: timestamp('transfer_time', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    index('idx_entry_event_transfers_entry_id').on(table.entryId),
    // FPL can return several transfers for one entry in one gameweek.  The
    // timestamp plus player pair identifies a transfer while still making
    // retries idempotent.
    uniqueIndex('unique_entry_event_transfer').on(
      table.entryId,
      table.eventId,
      table.transferTime,
      table.elementInId,
      table.elementOutId,
    ),
  ],
);

export type DbEntryEventTransfer = Readonly<typeof entryEventTransfers.$inferSelect>;
export type DbEntryEventTransfers = readonly DbEntryEventTransfer[];

export type DbEntryEventTransferInsert = Readonly<typeof entryEventTransfers.$inferInsert>;
export type DbEntryEventTransferInserts = readonly DbEntryEventTransferInsert[];
