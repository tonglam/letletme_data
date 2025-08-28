import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAtField } from './_helpers.schema';

export const teams = pgTable('teams', {
  id: integer('id').primaryKey(),
  code: integer('code').notNull().unique(),
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),
  strength: integer('strength').notNull(),
  position: integer('position').default(0).notNull(),
  points: integer('points').default(0).notNull(),
  played: integer('played').default(0).notNull(),
  win: integer('win').default(0).notNull(),
  draw: integer('draw').default(0).notNull(),
  loss: integer('loss').default(0).notNull(),
  form: text('form'),
  teamDivision: integer('team_division'),
  unavailable: integer('unavailable').default(0).notNull(),
  strengthOverallHome: integer('strength_overall_home').default(1000).notNull(),
  strengthOverallAway: integer('strength_overall_away').default(1000).notNull(),
  strengthAttackHome: integer('strength_attack_home').default(1000).notNull(),
  strengthAttackAway: integer('strength_attack_away').default(1000).notNull(),
  strengthDefenceHome: integer('strength_defence_home').default(1000).notNull(),
  strengthDefenceAway: integer('strength_defence_away').default(1000).notNull(),
  pulseId: integer('pulse_id').notNull().unique(),
  ...createdAtField,
});

export type DbTeam = Readonly<typeof teams.$inferSelect>;
export type DbTeams = readonly DbTeam[];

export type DbTeamInsert = Readonly<typeof teams.$inferInsert>;
export type DbTeamsInserts = readonly DbTeamInsert[];
