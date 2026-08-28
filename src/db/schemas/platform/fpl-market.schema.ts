// Canonical fpl market PostgreSQL schema declarations.
import {
  foreignKey,
  check,
  smallint,
  text,
  timestamp,
  index,
  uuid,
  integer,
  uniqueIndex,
  date,
  numeric,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { fpl } from './namespaces.schema';
import { seasonsInFpl, playersInFpl, teamsInFpl, eventsInFpl } from './fpl.schema';
import { fplSourceArtifactsInOps } from './ops.schema';

export const playerMarketSnapshotsInFpl = fpl.table(
  'player_market_snapshots',
  {
    seasonId: smallint('season_id').notNull(),
    snapshotDate: date('snapshot_date').notNull(),
    elementId: integer('element_id').notNull(),
    sourceSnapshotId: integer('source_snapshot_id').default(
      sql`nextval('fpl.player_market_snapshots_source_snapshot_id_seq'::regclass)`,
    ),
    snapshotSource: text('snapshot_source').default('upstream').notNull(),
    sourceValueId: integer('source_value_id'),
    sourceEventId: integer('source_event_id'),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).notNull(),
    playerCode: integer('player_code').notNull(),
    webName: text('web_name').notNull(),
    firstName: text('first_name').notNull(),
    secondName: text('second_name').notNull(),
    teamId: integer('team_id').notNull(),
    teamName: text('team_name').notNull(),
    teamShortName: text('team_short_name').notNull(),
    elementType: integer('element_type').notNull(),
    position: text().notNull(),
    price: integer().notNull(),
    selectedByPercent: numeric('selected_by_percent').notNull(),
    transfersIn: integer('transfers_in').notNull(),
    transfersOut: integer('transfers_out').notNull(),
    transfersInEvent: integer('transfers_in_event').notNull(),
    transfersOutEvent: integer('transfers_out_event').notNull(),
    status: text().notNull(),
    news: text().notNull(),
    newsAdded: timestamp('news_added', { withTimezone: true, mode: 'date' }),
    chanceOfPlayingThisRound: integer('chance_of_playing_this_round'),
    chanceOfPlayingNextRound: integer('chance_of_playing_next_round'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    // Added after the baseline table; keep declaration order aligned with the
    // migrated catalog so schema parity also catches accidental rewrites.
    sourceArtifactId: uuid('source_artifact_id'),
  },
  (table) => [
    index('player_market_snapshots_event_fk_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.sourceEventId.asc().nullsLast(),
    ),
    index('player_market_snapshots_player_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.elementId.asc().nullsLast(),
      table.snapshotDate.asc().nullsLast(),
    ),
    uniqueIndex('player_market_snapshots_source_id_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.sourceSnapshotId.asc().nullsLast())
      .where(sql`(source_snapshot_id IS NOT NULL)`),
    uniqueIndex('player_market_snapshots_source_value_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.sourceValueId.asc().nullsLast())
      .where(sql`(source_value_id IS NOT NULL)`),
    index('player_market_snapshots_team_idx').using(
      'btree',
      table.seasonId.asc().nullsLast(),
      table.teamId.asc().nullsLast(),
      table.snapshotDate.asc().nullsLast(),
    ),
    index('player_market_snapshots_source_artifact_idx')
      .using('btree', table.seasonId.asc().nullsLast(), table.sourceArtifactId.asc().nullsLast())
      .where(sql`(source_artifact_id IS NOT NULL)`),
    foreignKey({
      columns: [table.seasonId],
      foreignColumns: [seasonsInFpl.seasonId],
      name: 'player_market_snapshots_season_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.sourceEventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'player_market_snapshots_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.sourceArtifactId],
      foreignColumns: [fplSourceArtifactsInOps.seasonId, fplSourceArtifactsInOps.artifactId],
      name: 'player_market_snapshots_source_artifact_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.seasonId, table.elementId],
      foreignColumns: [playersInFpl.seasonId, playersInFpl.elementId],
      name: 'player_market_snapshots_player_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.teamId],
      foreignColumns: [teamsInFpl.seasonId, teamsInFpl.teamId],
      name: 'player_market_snapshots_team_fk',
    }),
    primaryKey({
      columns: [table.seasonId, table.snapshotDate, table.elementId],
      name: 'player_market_snapshots_pkey',
    }),
    check(
      'player_market_snapshots_ids_positive',
      sql`(element_id > 0) AND (player_code > 0) AND (team_id > 0) AND (element_type > 0) AND ((source_snapshot_id IS NULL) OR (source_snapshot_id > 0)) AND ((source_value_id IS NULL) OR (source_value_id > 0)) AND ((source_event_id IS NULL) OR (source_event_id > 0))`,
    ),
    check(
      'player_market_snapshots_source_valid',
      sql`((snapshot_source = 'upstream'::text) AND (source_snapshot_id IS NOT NULL) AND (source_value_id IS NULL)) OR ((snapshot_source = 'value_seed'::text) AND (source_snapshot_id IS NULL) AND (source_value_id IS NOT NULL) AND (source_event_id IS NOT NULL))`,
    ),
    check('player_market_snapshots_price_nonnegative', sql`price >= 0`),
    check(
      'player_market_snapshots_selected_percent',
      sql`(selected_by_percent >= (0)::numeric) AND (selected_by_percent <= (100)::numeric)`,
    ),
    check(
      'player_market_snapshots_transfers_nonnegative',
      sql`(transfers_in >= 0) AND (transfers_out >= 0) AND (transfers_in_event >= 0) AND (transfers_out_event >= 0)`,
    ),
    check(
      'player_market_snapshots_chance_valid',
      sql`((chance_of_playing_this_round IS NULL) OR ((chance_of_playing_this_round >= 0) AND (chance_of_playing_this_round <= 100))) AND ((chance_of_playing_next_round IS NULL) OR ((chance_of_playing_next_round >= 0) AND (chance_of_playing_next_round <= 100)))`,
    ),
  ],
);
