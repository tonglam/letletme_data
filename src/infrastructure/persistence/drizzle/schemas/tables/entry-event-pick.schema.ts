import { autoIncrementId, createdAtField } from '@app/schemas/_helpers.schema';
import { entryInfos } from '@app/schemas/entry-info.schema';
import { events } from '@app/schemas/event.schema';
import { index, integer, jsonb, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';
import { chipEnum } from 'enums.schema';

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

export type EntryEventPick = Readonly<typeof entryEventPicks.$inferSelect>;
export type EntryEventPicks = readonly EntryEventPick[];

export type EntryEventPickCreateInput = Readonly<typeof entryEventPicks.$inferInsert>;
export type EntryEventPickCreateInputs = readonly EntryEventPickCreateInput[];
