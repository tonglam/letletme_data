import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { fpl, ops } from './platform.schema';
import { eventsInFpl } from './platform.schema';

export const liveLifecycleStatusInOps = ops.table(
  'live_lifecycle_status',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    state: text().notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true, mode: 'date' }).notNull(),
    nextRefreshAt: timestamp('next_refresh_at', { withTimezone: true, mode: 'date' }),
    liveRevision: text('live_revision'),
    publicationId: uuid('publication_id'),
    sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.seasonId, table.eventId], name: 'live_lifecycle_status_pkey' }),
    index('live_lifecycle_status_refresh_idx').on(table.nextRefreshAt, table.state),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'live_lifecycle_status_event_fk',
    }),
    check('live_lifecycle_status_state_nonempty', sql`btrim(state) <> ''::text`),
  ],
);

export const managerEventScoreSnapshotsInFpl = fpl.table(
  'manager_event_score_snapshots',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    scopeType: text('scope_type').notNull(),
    scopeId: integer('scope_id').notNull(),
    entryId: integer('entry_id').notNull(),
    eventPoints: integer('event_points'),
    netEventPoints: integer('net_event_points'),
    totalPoints: integer('total_points'),
    totalScope: text('total_scope').notNull(),
    eventRank: integer('event_rank'),
    overallRank: integer('overall_rank'),
    leagueRank: integer('league_rank'),
    source: text().notNull(),
    transferCost: integer('transfer_cost'),
    eventPointSemantics: text('event_point_semantics').notNull(),
    contentRevision: text('content_revision').notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    upstreamUpdatedAt: timestamp('upstream_updated_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.eventId, table.scopeType, table.scopeId, table.entryId],
      name: 'manager_event_score_snapshots_pkey',
    }),
    index('manager_event_score_snapshots_entry_idx').on(
      table.seasonId,
      table.eventId,
      table.entryId,
      table.checkedAt,
    ),
    index('manager_event_score_snapshots_scope_idx').on(
      table.seasonId,
      table.eventId,
      table.scopeType,
      table.scopeId,
      table.checkedAt,
    ),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'manager_event_score_snapshots_event_fk',
    }),
    check('manager_event_score_snapshots_scope_nonempty', sql`btrim(scope_type) <> ''::text`),
  ],
);
