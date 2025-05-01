import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { createdAtField } from 'schema/_helpers.schema';
import { events } from 'schema/event.schema';

export const phases = pgTable('phases', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  startEvent: integer('start_event')
    .notNull()
    .references(() => events.id),
  stopEvent: integer('stop_event')
    .notNull()
    .references(() => events.id),
  highestScore: integer('highest_score'),
  ...createdAtField,
});
