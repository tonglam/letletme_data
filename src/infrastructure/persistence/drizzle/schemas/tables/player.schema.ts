import { createdAtField } from '@app/schemas/_helpers.schema';
import { teams } from '@app/schemas/team.schema';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';

export const players = pgTable('players', {
  id: integer('id').primaryKey(),
  code: integer('code').notNull().unique(),
  type: integer('element_type').notNull(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  price: integer('price').default(0).notNull(),
  startPrice: integer('start_price').default(0).notNull(),
  firstName: text('first_name'),
  secondName: text('second_name'),
  webName: text('web_name').notNull(),
  ...createdAtField,
});

export type DbPlayer = Readonly<typeof players.$inferSelect>;
export type DbPlayers = readonly DbPlayer[];

export type DbPlayerInsert = Readonly<typeof players.$inferInsert>;
export type DbPlayersInserts = readonly DbPlayerInsert[];
