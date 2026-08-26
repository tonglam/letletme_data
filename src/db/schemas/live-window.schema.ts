import {
  check,
  foreignKey,
  jsonb,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  bigint,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { eventsInFpl, fpl, ops, tournamentsInCompetition } from './platform.schema';

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
    check(
      'live_lifecycle_status_state_valid',
      sql`state IN (
        'PRE_DEADLINE', 'PICKS_WAIT', 'PICKS_PROBE', 'PICKS_SYNC',
        'LIVE_ACTIVE', 'BETWEEN_FIXTURES', 'DAY_SETTLING', 'GW_REVIEW',
        'FINALIZED'
      )`,
    ),
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
      table.checkedAt.desc(),
    ),
    index('manager_event_score_snapshots_scope_idx').on(
      table.seasonId,
      table.eventId,
      table.scopeType,
      table.scopeId,
      table.checkedAt.desc(),
    ),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'manager_event_score_snapshots_event_fk',
    }),
    check(
      'manager_event_score_snapshots_scope_valid',
      sql`(
        (scope_type = 'ENTRY' AND scope_id = 0)
        OR (scope_type = 'CLASSIC_LEAGUE' AND scope_id > 0)
      )`,
    ),
    check('manager_event_score_snapshots_ids_positive', sql`event_id > 0 AND entry_id > 0`),
    check(
      'manager_event_score_snapshots_source_valid',
      sql`source IN ('FPL_EVENT_LIVE', 'FPL_ENTRY_SUMMARY', 'FPL_CLASSIC_STANDINGS', 'FPL_FINAL_RESULT')`,
    ),
    check(
      'manager_event_score_snapshots_scope_total_valid',
      sql`total_scope IN ('OVERALL', 'CLASSIC_PHASE')`,
    ),
    check(
      'manager_event_score_snapshots_semantics_valid',
      sql`event_point_semantics IN ('GROSS', 'NET', 'ZERO_COST_EQUIVALENT', 'UNKNOWN')`,
    ),
    check(
      'manager_event_score_snapshots_revision_nonempty',
      sql`btrim(content_revision) <> ''::text`,
    ),
  ],
);

/**
 * Durable progress for a tournament-scoped manager-live crawl.  The score
 * checkpoints remain the row-level source of truth; this table records the
 * bounded crawl obligation that lets GraphQL distinguish a complete field
 * from a healthy but still warming partial field.
 */
export const managerLiveTournamentCoverageInFpl = fpl.table(
  'manager_live_tournament_coverage',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    tournamentId: integer('tournament_id').notNull(),
    rosterRevision: text('roster_revision').notNull(),
    expectedEntries: integer('expected_entries').notNull(),
    resolvedEntries: integer('resolved_entries').notNull(),
    fullyFetchedAt: timestamp('fully_fetched_at', { withTimezone: true, mode: 'date' }),
    managerRevision: text('manager_revision'),
    error: text(),
    state: text().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.eventId, table.tournamentId],
      name: 'manager_live_tournament_coverage_pkey',
    }),
    index('manager_live_tournament_coverage_state_idx').on(
      table.seasonId,
      table.eventId,
      table.state,
      table.updatedAt.desc().nullsLast(),
    ),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'manager_live_tournament_coverage_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.tournamentId],
      foreignColumns: [tournamentsInCompetition.seasonId, tournamentsInCompetition.tournamentId],
      name: 'manager_live_tournament_coverage_tournament_fk',
    }).onDelete('cascade'),
    check(
      'manager_live_tournament_coverage_state_valid',
      sql`state IN ('WARMING', 'COMPLETE', 'PARTIAL', 'UNAVAILABLE')`,
    ),
    check(
      'manager_live_tournament_coverage_counts_valid',
      sql`expected_entries >= 0 AND resolved_entries >= 0 AND resolved_entries <= expected_entries`,
    ),
    check('manager_live_tournament_coverage_ids_positive', sql`event_id > 0 AND tournament_id > 0`),
    check(
      'manager_live_tournament_coverage_revision_nonempty',
      sql`btrim(roster_revision) <> ''::text`,
    ),
  ],
);

export const managerEventScoreMaterializationsInFpl = fpl.table(
  'manager_event_score_materializations',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    entryId: integer('entry_id').notNull(),
    inputRevision: text('input_revision').notNull(),
    scoreRevision: text('score_revision').notNull(),
    calculationMode: text('calculation_mode').notNull(),
    algorithmVersion: text('algorithm_version').notNull(),
    scoreSource: text('score_source').notNull(),
    livePublicationId: uuid('live_publication_id').notNull(),
    liveRevision: text('live_revision').notNull(),
    liveCheckedAt: timestamp('live_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    picksRevision: text('picks_revision').notNull(),
    picksCheckedAt: timestamp('picks_checked_at', { withTimezone: true, mode: 'date' }).notNull(),
    previousTotalsRevision: text('previous_totals_revision').notNull(),
    previousTotalsThroughEventId: integer('previous_totals_through_event_id'),
    resultRevision: text('result_revision'),
    resultCheckedAt: timestamp('result_checked_at', { withTimezone: true, mode: 'date' }),
    dataCheckedAt: timestamp('data_checked_at', { withTimezone: true, mode: 'date' }),
    rankRevision: text('rank_revision'),
    rankSource: text('rank_source'),
    rankCheckedAt: timestamp('rank_checked_at', { withTimezone: true, mode: 'date' }),
    eventPoints: integer('event_points').notNull(),
    netEventPoints: integer('net_event_points').notNull(),
    totalPoints: integer('total_points'),
    transferCost: integer('transfer_cost').notNull(),
    effectiveLineup: jsonb('effective_lineup').notNull(),
    sourceMinCheckedAt: timestamp('source_min_checked_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    sourceMaxCheckedAt: timestamp('source_max_checked_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.eventId, table.entryId, table.inputRevision],
      name: 'manager_event_score_materializations_pkey',
    }),
    index('manager_event_score_materializations_lookup_idx').on(
      table.seasonId,
      table.eventId,
      table.entryId,
      table.calculationMode,
      table.createdAt.desc(),
    ),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'manager_event_score_materializations_event_fk',
    }),
    check(
      'manager_event_score_materializations_mode_valid',
      sql`calculation_mode = 'PROJECTED_AUTOSUBS'`,
    ),
    check(
      'manager_event_score_materializations_source_valid',
      sql`score_source = 'FPL_EVENT_LIVE'`,
    ),
    check(
      'manager_event_score_materializations_algorithm_valid',
      sql`algorithm_version = 'fpl-projected-autosubs-v1'`,
    ),
    check(
      'manager_event_score_materializations_revision_nonempty',
      sql`btrim(input_revision) <> '' AND btrim(score_revision) <> '' AND btrim(algorithm_version) <> '' AND btrim(live_revision) <> '' AND btrim(picks_revision) <> '' AND btrim(previous_totals_revision) <> ''`,
    ),
    check(
      'manager_event_score_materializations_previous_event_valid',
      sql`previous_totals_through_event_id IS NULL OR previous_totals_through_event_id >= 0`,
    ),
    check(
      'manager_event_score_materializations_lineup_complete',
      sql`jsonb_typeof(effective_lineup) = 'array' AND jsonb_array_length(effective_lineup) = 15`,
    ),
    check(
      'manager_event_score_materializations_points_reconcile',
      sql`transfer_cost >= 0 AND net_event_points = event_points - transfer_cost`,
    ),
    check(
      'manager_event_score_materializations_source_span_valid',
      sql`source_min_checked_at <= source_max_checked_at`,
    ),
    check(
      'manager_event_score_materializations_rank_source_valid',
      sql`rank_source IS NULL OR rank_source IN ('FPL_ENTRY_SUMMARY', 'FPL_CLASSIC_STANDINGS')`,
    ),
  ],
);

export const managerEventScoreHeadsInFpl = fpl.table(
  'manager_event_score_heads',
  {
    seasonId: smallint('season_id').notNull(),
    eventId: integer('event_id').notNull(),
    entryId: integer('entry_id').notNull(),
    calculationMode: text('calculation_mode').notNull(),
    inputRevision: text('input_revision').notNull(),
    scoreRevision: text('score_revision').notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    verifiedLiveRevision: text('verified_live_revision').notNull(),
    verifiedPicksRevision: text('verified_picks_revision').notNull(),
    verifiedPreviousTotalsRevision: text('verified_previous_totals_revision').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    verifiedLiveCheckedAt: timestamp('verified_live_checked_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.seasonId, table.eventId, table.entryId, table.calculationMode],
      name: 'manager_event_score_heads_pkey',
    }),
    index('manager_event_score_heads_generation_idx').on(
      table.seasonId,
      table.eventId,
      table.calculationMode,
      table.generation.desc(),
    ),
    foreignKey({
      columns: [table.seasonId, table.eventId],
      foreignColumns: [eventsInFpl.seasonId, eventsInFpl.eventId],
      name: 'manager_event_score_heads_event_fk',
    }),
    foreignKey({
      columns: [table.seasonId, table.eventId, table.entryId, table.inputRevision],
      foreignColumns: [
        managerEventScoreMaterializationsInFpl.seasonId,
        managerEventScoreMaterializationsInFpl.eventId,
        managerEventScoreMaterializationsInFpl.entryId,
        managerEventScoreMaterializationsInFpl.inputRevision,
      ],
      name: 'manager_event_score_heads_materialization_fk',
    }),
    check('manager_event_score_heads_mode_valid', sql`calculation_mode = 'PROJECTED_AUTOSUBS'`),
    check('manager_event_score_heads_generation_positive', sql`generation > 0`),
    check(
      'manager_event_score_heads_revision_nonempty',
      sql`btrim(input_revision) <> '' AND btrim(score_revision) <> '' AND btrim(verified_live_revision) <> '' AND btrim(verified_picks_revision) <> '' AND btrim(verified_previous_totals_revision) <> ''`,
    ),
  ],
);
