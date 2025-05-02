import { createdAtField } from '@app/schemas/_helpers.schema';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

export const teams = pgTable('teams', {
  id: integer('id').primaryKey(),
  code: integer('code').notNull().unique(),
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),
  strength: integer('strength').notNull(),
  position: integer('position').default(0).notNull(),
  points: integer('points').default(0).notNull(),
  win: integer('win').default(0).notNull(),
  draw: integer('draw').default(0).notNull(),
  loss: integer('loss').default(0).notNull(),
  ...createdAtField,
});

export type Team = Readonly<typeof teams.$inferSelect>;
export type Teams = readonly Team[];

export type TeamCreateInput = Readonly<typeof teams.$inferInsert>;
export type TeamCreateInputs = readonly TeamCreateInput[];
