import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { createdAtField } from 'schema/_helpers';
import { teams } from 'schema/team';

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
