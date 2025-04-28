import { pgTable, integer, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { autoIncrementId, createdAtField } from 'schema/_helpers';
import { entryInfos } from 'schema/entry-info';
import { chipEnum } from 'schema/enums';
import { events } from 'schema/event';

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
