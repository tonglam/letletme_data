import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { autoIncrementId } from './_helpers.schema';
import { players } from './players.schema';
import { teams } from './teams.schema';

export const playerMarketSnapshots = pgTable(
  'player_market_snapshots',
  {
    ...autoIncrementId,
    snapshotDate: date('snapshot_date', { mode: 'string' }).notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    elementId: integer('element_id')
      .notNull()
      .references(() => players.id),
    playerCode: integer('player_code').notNull(),
    webName: text('web_name').notNull(),
    firstName: text('first_name').notNull(),
    secondName: text('second_name').notNull(),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    teamName: text('team_name').notNull(),
    teamShortName: text('team_short_name').notNull(),
    elementType: integer('element_type').notNull(),
    position: text('position').notNull(),
    price: integer('price').notNull(),
    selectedByPercent: numeric('selected_by_percent', {
      precision: 6,
      scale: 3,
      mode: 'number',
    }).notNull(),
    transfersIn: integer('transfers_in').notNull(),
    transfersOut: integer('transfers_out').notNull(),
    transfersInEvent: integer('transfers_in_event').notNull(),
    transfersOutEvent: integer('transfers_out_event').notNull(),
    status: text('status').notNull(),
    news: text('news').notNull(),
    newsAdded: timestamp('news_added', { withTimezone: true }),
    chanceOfPlayingThisRound: integer('chance_of_playing_this_round'),
    chanceOfPlayingNextRound: integer('chance_of_playing_next_round'),
  },
  (table) => [
    uniqueIndex('unique_player_market_snapshot_day').on(table.snapshotDate, table.elementId),
    index('idx_player_market_snapshots_element_date').on(table.elementId, table.snapshotDate),
    index('idx_player_market_snapshots_date_ownership').on(
      table.snapshotDate,
      table.selectedByPercent,
    ),
    check('player_market_snapshots_element_type_check', sql`${table.elementType} between 1 and 4`),
    check(
      'player_market_snapshots_position_check',
      sql`${table.position} in ('GKP', 'DEF', 'MID', 'FWD')`,
    ),
    check('player_market_snapshots_price_check', sql`${table.price} > 0`),
    check(
      'player_market_snapshots_ownership_check',
      sql`${table.selectedByPercent} between 0 and 100`,
    ),
    check(
      'player_market_snapshots_transfer_counts_check',
      sql`${table.transfersIn} >= 0 and ${table.transfersOut} >= 0 and ${table.transfersInEvent} >= 0 and ${table.transfersOutEvent} >= 0`,
    ),
    check(
      'player_market_snapshots_chance_this_check',
      sql`${table.chanceOfPlayingThisRound} is null or ${table.chanceOfPlayingThisRound} between 0 and 100`,
    ),
    check(
      'player_market_snapshots_chance_next_check',
      sql`${table.chanceOfPlayingNextRound} is null or ${table.chanceOfPlayingNextRound} between 0 and 100`,
    ),
  ],
);

export type DbPlayerMarketSnapshot = Readonly<typeof playerMarketSnapshots.$inferSelect>;
export type DbPlayerMarketSnapshotInsert = Readonly<typeof playerMarketSnapshots.$inferInsert>;
