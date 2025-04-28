import { autoIncrementId, createdAtField } from 'db/schema/_helpers';
import { pgTable, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { entryInfos } from 'schema/entry-info';
import { events } from 'schema/event';
import { players } from 'schema/player';

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
