import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { databaseSingleton, getDbClient } from '../../src/db/singleton';

const enabled = process.env.RUN_P5_BENCHMARK === '1';
const SEASON_ID = 2026;
const TOURNAMENT_ID = 9_500_001;
const LEAGUE_ID = 9_500_001;
const FIRST_ENTRY_ID = 9_500_001;
const ENTRY_COUNT = 500;
const EVENT_COUNT = 38;
const PICKS_PER_ENTRY = 15;

setDefaultTimeout(180_000);

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
}

function summarize(samples: number[]): { p50Ms: number; p95Ms: number; maxMs: number } {
  return {
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
  };
}

async function refreshSelectionView(): Promise<number> {
  const sql = await getDbClient();
  const startedAt = performance.now();
  await sql`SELECT reporting.refresh_tournament_selection_stats()`;
  return performance.now() - startedAt;
}

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql.begin(async (transaction) => {
    await transaction`
      DELETE FROM competition.entry_event_picks
      WHERE season_id = ${SEASON_ID}
        AND entry_id BETWEEN ${FIRST_ENTRY_ID} AND ${FIRST_ENTRY_ID + ENTRY_COUNT - 1}
    `;
    await transaction`
      DELETE FROM competition.tournament_entries
      WHERE tournament_id = ${TOURNAMENT_ID}
    `;
    await transaction`
      DELETE FROM competition.tournaments
      WHERE tournament_id = ${TOURNAMENT_ID}
    `;
    await transaction`
      DELETE FROM competition.entries
      WHERE season_id = ${SEASON_ID}
        AND entry_id BETWEEN ${FIRST_ENTRY_ID} AND ${FIRST_ENTRY_ID + ENTRY_COUNT - 1}
    `;
  });
  await refreshSelectionView();
}

async function seed(): Promise<void> {
  const sql = await getDbClient();
  await cleanup();

  const players = await sql<Array<{ element_id: number }>>`
    WITH ranked AS (
      SELECT
        player.element_id,
        player.element_type,
        row_number() OVER (
          PARTITION BY player.element_type
          ORDER BY player.element_id
        ) AS position_rank
      FROM fpl.players player
      WHERE player.season_id = ${SEASON_ID}
    )
    SELECT element_id
    FROM ranked
    WHERE position_rank <= CASE element_type
      WHEN 1 THEN 2
      WHEN 2 THEN 5
      WHEN 3 THEN 5
      WHEN 4 THEN 3
      ELSE 0
    END
    ORDER BY element_type, position_rank
  `;
  const playerIds = players.map((player) => player.element_id);
  expect(playerIds).toHaveLength(PICKS_PER_ENTRY);

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO competition.entries (
        season_id,
        entry_id,
        entry_name,
        player_name,
        started_event,
        last_event_id,
        snapshot_synced_through_event_id,
        transfers_synced_through_event_id,
        transfers_source_checked_at,
        created_at,
        updated_at
      )
      SELECT
        ${SEASON_ID},
        ${FIRST_ENTRY_ID} + manager.ordinality - 1,
        'P5 Entry ' || manager.ordinality::text,
        'P5 Manager ' || manager.ordinality::text,
        1,
        ${EVENT_COUNT},
        ${EVENT_COUNT},
        ${EVENT_COUNT},
        timestamptz '2026-08-09 00:00:00+00',
        timestamptz '2026-08-09 00:00:00+00',
        timestamptz '2026-08-09 00:00:00+00'
      FROM generate_series(1, ${ENTRY_COUNT}) AS manager(ordinality)
    `;

    await transaction`
      INSERT INTO competition.tournaments (
        tournament_id,
        season_id,
        name,
        creator,
        admin_entry_id,
        league_id,
        league_type,
        total_team_num,
        tournament_mode,
        group_mode,
        group_auto_averages,
        state,
        setup_status,
        setup_started_at,
        setup_finished_at,
        setup_phase,
        setup_completed_units,
        setup_total_units,
        setup_progress_updated_at,
        standings_ready_at,
        setup_warning_count,
        created_at,
        updated_at
      )
      VALUES (
        ${TOURNAMENT_ID},
        ${SEASON_ID},
        'P5 500-entry reporting benchmark',
        'p5-rehearsal',
        ${FIRST_ENTRY_ID},
        ${LEAGUE_ID},
        'classic',
        ${ENTRY_COUNT},
        'normal',
        'no_group',
        false,
        'active',
        'ready',
        timestamptz '2026-08-09 00:00:00+00',
        timestamptz '2026-08-09 00:00:00+00',
        'ready',
        1,
        1,
        timestamptz '2026-08-09 00:00:00+00',
        timestamptz '2026-08-09 00:00:00+00',
        0,
        timestamptz '2026-08-09 00:00:00+00',
        timestamptz '2026-08-09 00:00:00+00'
      )
    `;

    await transaction`
      INSERT INTO competition.tournament_entries (
        tournament_id,
        season_id,
        league_id,
        entry_id,
        created_at
      )
      SELECT
        ${TOURNAMENT_ID},
        ${SEASON_ID},
        ${LEAGUE_ID},
        ${FIRST_ENTRY_ID} + manager.ordinality - 1,
        timestamptz '2026-08-09 00:00:00+00'
      FROM generate_series(1, ${ENTRY_COUNT}) AS manager(ordinality)
    `;

    await transaction`
      INSERT INTO competition.entry_event_picks (
        season_id,
        entry_id,
        event_id,
        position,
        element_id,
        multiplier,
        is_captain,
        is_vice_captain,
        active_chip,
        transfers,
        transfers_cost,
        source_created_at,
        source_updated_at
      )
      SELECT
        ${SEASON_ID},
        ${FIRST_ENTRY_ID} + manager.ordinality - 1,
        event.event_id,
        player.position::smallint,
        player.element_id,
        CASE
          WHEN player.position = ((manager.ordinality + event.event_id - 2) % 11) + 1 THEN 2
          WHEN player.position > 11 THEN 0
          ELSE 1
        END::smallint,
        player.position = ((manager.ordinality + event.event_id - 2) % 11) + 1,
        player.position = ((manager.ordinality + event.event_id - 1) % 11) + 1,
        CASE WHEN player.position = 1 THEN 'n/a'::competition.chip ELSE NULL END,
        CASE WHEN player.position = 1 THEN 0 ELSE NULL END,
        CASE WHEN player.position = 1 THEN 0 ELSE NULL END,
        timestamptz '2026-08-09 00:00:00+00',
        timestamptz '2026-08-09 00:00:00+00'
      FROM generate_series(1, ${ENTRY_COUNT}) AS manager(ordinality)
      CROSS JOIN (
        SELECT event_id
        FROM fpl.events
        WHERE season_id = ${SEASON_ID}
        ORDER BY event_id
        LIMIT ${EVENT_COUNT}
      ) event
      CROSS JOIN unnest(${playerIds}::integer[])
        WITH ORDINALITY AS player(element_id, position)
    `;
  });

  // The fixture is loaded in one transaction, unlike the gradual production sync. Make the
  // planner state production-like before measuring the MV refresh so a race with autovacuum
  // cannot turn the same workload into a false pass or false failure.
  await sql`ANALYZE competition.entries`;
  await sql`ANALYZE competition.tournament_entries`;
  await sql`ANALYZE competition.entry_event_picks`;
  await sql`ANALYZE competition.entry_event_transfers`;
}

describe.skipIf(!enabled)('P5 reporting performance budgets', () => {
  beforeAll(seed);
  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await databaseSingleton.disconnect();
    }
  });

  test('refreshes a complete 500 x 38 x 15 selection workload within budget', async () => {
    const sql = await getDbClient();
    const refreshMs = await refreshSelectionView();
    const [result] = await sql<
      Array<{
        rows: number;
        scope_count: number;
        invalid_scope_count: number;
      }>
    >`
      WITH scope_totals AS (
        SELECT
          event_id,
          sum(selected_count)::integer AS selected_count,
          sum(captain_count)::integer AS captain_count,
          sum(vice_captain_count)::integer AS vice_captain_count,
          min(total_entries)::integer AS min_entries,
          max(total_entries)::integer AS max_entries
        FROM reporting.tournament_selection_stats
        WHERE tournament_id = ${TOURNAMENT_ID}
        GROUP BY event_id
      )
      SELECT
        (SELECT count(*)::integer FROM reporting.tournament_selection_stats
         WHERE tournament_id = ${TOURNAMENT_ID}) AS rows,
        count(*)::integer AS scope_count,
        count(*) FILTER (
          WHERE selected_count <> ${ENTRY_COUNT * PICKS_PER_ENTRY}
             OR captain_count <> ${ENTRY_COUNT}
             OR vice_captain_count <> ${ENTRY_COUNT}
             OR min_entries <> ${ENTRY_COUNT}
             OR max_entries <> ${ENTRY_COUNT}
        )::integer AS invalid_scope_count
      FROM scope_totals
    `;

    process.stdout.write(
      `${JSON.stringify({
        benchmark: 'tournament-selection-mv-refresh',
        entries: ENTRY_COUNT,
        events: EVENT_COUNT,
        picksPerEntry: PICKS_PER_ENTRY,
        sourceRows: ENTRY_COUNT * EVENT_COUNT * PICKS_PER_ENTRY,
        refreshMs: Number(refreshMs.toFixed(2)),
        outputRows: result?.rows,
        plannerStatistics: 'explicitly-analyzed-after-bulk-fixture-load',
      })}\n`,
    );

    expect(result).toEqual({
      rows: EVENT_COUNT * PICKS_PER_ENTRY,
      scope_count: 38,
      invalid_scope_count: 0,
    });
    expect(refreshMs).toBeLessThanOrEqual(30_000);
  }, 60_000);

  test('meets selection and player-summary cold database p95 budgets', async () => {
    const sql = await getDbClient();
    const [subject] = await sql<Array<{ element_id: number }>>`
      SELECT element_id
      FROM fpl.player_gameweek_stats
      WHERE season_id = 2025
      GROUP BY element_id
      ORDER BY count(*) DESC, element_id
      LIMIT 1
    `;
    expect(subject?.element_id).toBeGreaterThan(0);

    const selectionSamples: number[] = [];
    const summarySamples: number[] = [];
    for (let iteration = 0; iteration < 5; iteration += 1) {
      await sql`
        SELECT *
        FROM reporting.tournament_selection_stats
        WHERE tournament_id = ${TOURNAMENT_ID} AND event_id = 1
        ORDER BY selected_count DESC, element_id
        LIMIT 15
      `;
      await sql`
        SELECT *
        FROM reporting.player_season_summaries
        WHERE season_id = 2025 AND element_id = ${subject?.element_id ?? 0}
      `;
    }
    for (let iteration = 0; iteration < 30; iteration += 1) {
      let startedAt = performance.now();
      await sql`
        SELECT *
        FROM reporting.tournament_selection_stats
        WHERE tournament_id = ${TOURNAMENT_ID} AND event_id = 1
        ORDER BY selected_count DESC, element_id
        LIMIT 15
      `;
      selectionSamples.push(performance.now() - startedAt);

      startedAt = performance.now();
      await sql`
        SELECT *
        FROM reporting.player_season_summaries
        WHERE season_id = 2025 AND element_id = ${subject?.element_id ?? 0}
      `;
      summarySamples.push(performance.now() - startedAt);
    }

    const selection = summarize(selectionSamples);
    const playerSummary = summarize(summarySamples);
    process.stdout.write(
      `${JSON.stringify({
        benchmark: 'reporting-db-reads',
        samples: 30,
        selection: {
          p50Ms: Number(selection.p50Ms.toFixed(3)),
          p95Ms: Number(selection.p95Ms.toFixed(3)),
          maxMs: Number(selection.maxMs.toFixed(3)),
        },
        playerSummary: {
          p50Ms: Number(playerSummary.p50Ms.toFixed(3)),
          p95Ms: Number(playerSummary.p95Ms.toFixed(3)),
          maxMs: Number(playerSummary.maxMs.toFixed(3)),
        },
      })}\n`,
    );

    expect(selection.p95Ms).toBeLessThanOrEqual(100);
    expect(playerSummary.p95Ms).toBeLessThanOrEqual(150);
  }, 60_000);
});
