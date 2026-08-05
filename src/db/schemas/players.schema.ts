import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { timestamps } from './_helpers.schema';
import { teams } from './teams.schema';

export const players = pgTable('players', {
  id: integer('id').primaryKey(),
  code: integer('code').notNull().unique(),
  type: integer('type').notNull(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  price: integer('price').default(0).notNull(),
  priceSourceCheckedAt: timestamp('price_source_checked_at', { withTimezone: true }),
  startPrice: integer('start_price').default(0).notNull(),
  firstName: text('first_name'),
  secondName: text('second_name'),
  webName: text('web_name').notNull(),
  ...timestamps,
});

export type DbPlayer = Readonly<typeof players.$inferSelect>;
export type DbPlayers = readonly DbPlayer[];

export type DbPlayerInsert = Readonly<typeof players.$inferInsert>;
export type DbPlayersInserts = readonly DbPlayerInsert[];
