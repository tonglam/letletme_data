import { autoIncrementId } from '@app/schemas/_helpers.schema';
import { events } from '@app/schemas/event.schema';
import { players } from '@app/schemas/player.schema';
import { char, index, integer, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { valueChangeTypeEnum } from 'enums.schema';

export const playerValues = pgTable(
  'player_values',
  {
    ...autoIncrementId,
    elementId: integer('element_id')
      .notNull()
      .references(() => players.id),
    elementType: integer('element_type').notNull(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    value: integer('value').notNull(),
    changeDate: char('change_date', { length: 8 }).notNull(),
    changeType: valueChangeTypeEnum('change_type').notNull(),
    lastValue: integer('last_value').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('unique_player_values').on(table.elementId, table.changeDate),
    index('idx_player_values_element_id').on(table.elementId),
    index('idx_player_values_change_date').on(table.changeDate),
  ],
);

export type DbPlayerValue = Readonly<typeof playerValues.$inferSelect>;
export type DbPlayerValues = readonly DbPlayerValue[];

export type DbPlayerValueInsert = Readonly<typeof playerValues.$inferInsert>;
export type DbPlayerValuesInserts = readonly DbPlayerValueInsert[];
