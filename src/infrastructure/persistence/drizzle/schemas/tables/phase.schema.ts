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

export type DbPhase = Readonly<typeof phases.$inferSelect>;
export type DbPhases = readonly DbPhase[];

export type DbPhaseInsert = Readonly<typeof phases.$inferInsert>;
export type DbPhaseInserts = readonly DbPhaseInsert[];
