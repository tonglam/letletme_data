import { autoIncrementId, createdAtField } from '@app/schemas/_helpers.schema';
import { entryInfos } from '@app/schemas/entry-info.schema';
import { events } from '@app/schemas/event.schema';
import { players } from '@app/schemas/player.schema';
import { index, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

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
    elementOutId: integer('element_out_id').references(() => players.id),
    elementOutCost: integer('element_out_cost'),
    elementOutPoints: integer('element_out_points'),
    transferTime: timestamp('transfer_time', { withTimezone: true }).notNull(),
    ...createdAtField,
  },
  (table) => [index('idx_entry_event_transfers_entry_id').on(table.entryId)],
);

export type DbEntryEventTransfer = Readonly<typeof entryEventTransfers.$inferSelect>;
export type DbEntryEventTransfers = readonly DbEntryEventTransfer[];

export type DbEntryEventTransferInsert = Readonly<typeof entryEventTransfers.$inferInsert>;
export type DbEntryEventTransferInserts = readonly DbEntryEventTransferInsert[];
