import { integer, timestamp } from 'drizzle-orm/pg-core';

export const autoIncrementId = {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
};

export const createdAtField = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
};

export const updatedAtField = {
  updatedAt: timestamp('updated_at', { withTimezone: true }).$onUpdate(() => new Date()),
};

export const timestamps = {
  ...createdAtField,
  ...updatedAtField,
};
