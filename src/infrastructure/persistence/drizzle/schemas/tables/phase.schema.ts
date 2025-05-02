import { createdAtField } from '@app/schemas/_helpers.schema';
import { events } from '@app/schemas/event.schema';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

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

export type Phase = Readonly<typeof phases.$inferSelect>;
export type Phases = readonly Phase[];

export type PhaseCreateInput = Readonly<typeof phases.$inferInsert>;
export type PhaseCreateInputs = readonly PhaseCreateInput[];
