import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import { seasonRepository } from '../../src/repositories/seasons';
import {
  refreshTournamentSelectionStatsMaterializedView,
  syncTournamentSelectionStats,
} from '../../src/services/tournament-selection-stats.service';
import { IncompleteDataSyncError } from '../../src/utils/errors';

const SEASON_ID = 2011;
const EVENT_ID = 1;
const TEAM_ID = 990_101;
const TOURNAMENT_ID = 990_101;
const LEAGUE_ID = 990_101;
const ENTRY_IDS = [990_101, 990_102] as const;
const PLAYER_IDS = Array.from({ length: 15 }, (_, index) => 990_201 + index);

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM competition.entry_event_picks
    WHERE season_id = ${SEASON_ID}
      AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
  `;
  await sql`
    DELETE FROM competition.tournament_entries
    WHERE tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.tournaments
    WHERE tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.entries
    WHERE season_id = ${SEASON_ID}
      AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
  `;
  await sql`
    DELETE FROM fpl.players
    WHERE season_id = ${SEASON_ID}
      AND element_id = ANY(${PLAYER_IDS}::integer[])
  `;
  await sql`
    DELETE FROM fpl.events
    WHERE season_id = ${SEASON_ID}
      AND event_id = ${EVENT_ID}
  `;
  await sql`
    DELETE FROM fpl.teams
    WHERE season_id = ${SEASON_ID}
      AND team_id = ${TEAM_ID}
  `;
  await sql`
    DELETE FROM fpl.seasons
    WHERE season_id = ${SEASON_ID}
      AND season_code = '1112'
  `;
  await refreshTournamentSelectionStatsMaterializedView();
}

async function seed(): Promise<void> {
  const sql = await getDbClient();
  await cleanup();

  await sql`
    INSERT INTO fpl.seasons (
      season_id,
      season_code,
      display_name,
      start_year,
      end_year,
      lifecycle_state,
      is_current
    )
    VALUES (
      ${SEASON_ID},
      '1112',
      '2011/12 tournament selection integration',
      ${SEASON_ID},
      ${SEASON_ID + 1},
      'completed',
      false
    )
  `;
  await sql`
    INSERT INTO fpl.teams (season_id, team_id, code, name, short_name)
    VALUES (${SEASON_ID}, ${TEAM_ID}, ${TEAM_ID}, 'Integration Team', 'INT')
  `;
  await sql`
    INSERT INTO fpl.players (
      season_id,
      element_id,
      code,
      element_type,
      team_id,
      web_name
    )
    SELECT
      ${SEASON_ID},
      player.element_id,
      player.element_id + 100000,
      ((player.ordinality - 1) % 4 + 1)::integer,
      ${TEAM_ID},
      'Integration ' || player.ordinality::text
    FROM unnest(${PLAYER_IDS}::integer[]) WITH ORDINALITY AS player(element_id, ordinality)
  `;
  await sql`
    INSERT INTO fpl.events (season_id, event_id, name)
    VALUES (${SEASON_ID}, ${EVENT_ID}, 'Integration GW 1')
  `;
  await sql`
    INSERT INTO competition.entries (
      season_id,
      entry_id,
      entry_name,
      player_name,
      started_event,
      last_event_id,
      snapshot_synced_through_event_id,
      transfers_synced_through_event_id,
      transfers_source_checked_at
    )
    SELECT
      ${SEASON_ID},
      entry.entry_id,
      'Integration Entry ' || entry.ordinality::text,
      'Integration Manager ' || entry.ordinality::text,
      1,
      1,
      1,
      1,
      timestamptz '2026-08-09 01:00:00+00'
    FROM unnest(${[...ENTRY_IDS]}::integer[]) WITH ORDINALITY AS entry(entry_id, ordinality)
  `;
  await sql`
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
      state
    )
    VALUES (
      ${TOURNAMENT_ID},
      ${SEASON_ID},
      'Integration Selection Contract',
      'integration-test',
      ${ENTRY_IDS[0]},
      ${LEAGUE_ID},
      'classic',
      2,
      'normal',
      'no_group',
      false,
      'active'
    )
  `;
  await sql`
    INSERT INTO competition.tournament_entries (
      tournament_id,
      season_id,
      league_id,
      entry_id
    )
    SELECT ${TOURNAMENT_ID}, ${SEASON_ID}, ${LEAGUE_ID}, entry_id
    FROM unnest(${[...ENTRY_IDS]}::integer[]) AS entry(entry_id)
  `;
  await sql`
    INSERT INTO competition.entry_event_picks (
      season_id,
      entry_id,
      event_id,
      position,
      element_id,
      multiplier,
      is_captain,
      is_vice_captain,
      source_created_at,
      source_updated_at
    )
    SELECT
      ${SEASON_ID},
      entry.entry_id,
      ${EVENT_ID},
      player.ordinality::smallint,
      player.element_id,
      CASE
        WHEN player.ordinality > 11 THEN 0
        WHEN (entry.entry_id = ${ENTRY_IDS[0]} AND player.ordinality = 1)
          OR (entry.entry_id = ${ENTRY_IDS[1]} AND player.ordinality = 2)
        THEN 2
        ELSE 1
      END::smallint,
      (
        (entry.entry_id = ${ENTRY_IDS[0]} AND player.ordinality = 1)
        OR (entry.entry_id = ${ENTRY_IDS[1]} AND player.ordinality = 2)
      ),
      (
        (entry.entry_id = ${ENTRY_IDS[0]} AND player.ordinality = 2)
        OR (entry.entry_id = ${ENTRY_IDS[1]} AND player.ordinality = 1)
      ),
      timestamptz '2026-08-09 01:00:00+00',
      timestamptz '2026-08-09 01:00:00+00'
    FROM unnest(${[...ENTRY_IDS]}::integer[]) AS entry(entry_id)
    CROSS JOIN unnest(${PLAYER_IDS}::integer[])
      WITH ORDINALITY AS player(element_id, ordinality)
  `;
}

beforeAll(seed);
afterAll(cleanup);

describe('tournament selection reporting materialized view', () => {
  test('calculates once, uses eligible-entry denominators, and fails closed on incomplete sources', async () => {
    const sql = await getDbClient();
    const season = await seasonRepository.requireByCode('1112');

    const result = await syncTournamentSelectionStats(season, EVENT_ID, {
      tournamentIds: [TOURNAMENT_ID],
    });
    expect(result).toMatchObject({
      eventId: EVENT_ID,
      tournaments: 1,
      sourceEntries: 2,
      rows: 15,
      requiredUnits: 1,
      succeededUnits: 1,
      failedUnits: 0,
    });

    const [totals] = await sql<
      Array<{ selections: number; captains: number; vice_captains: number }>
    >`
      SELECT
        sum(selected_count)::integer AS selections,
        sum(captain_count)::integer AS captains,
        sum(vice_captain_count)::integer AS vice_captains
      FROM reporting.tournament_selection_stats
      WHERE tournament_id = ${TOURNAMENT_ID}
        AND season_id = ${SEASON_ID}
        AND event_id = ${EVENT_ID}
    `;
    expect(totals).toEqual({ selections: 30, captains: 2, vice_captains: 2 });

    const readPlayer = async () => {
      const rows = await sql<
        Array<{
          total_entries: number;
          selected_count: number;
          captain_count: number;
          vice_captain_count: number;
          effective_selection_count: number;
          selection_percentage: string;
          captain_percentage: string;
          vice_captain_percentage: string;
          effective_ownership_percentage: string;
        }>
      >`
        SELECT
          total_entries,
          selected_count,
          captain_count,
          vice_captain_count,
          effective_selection_count,
          selection_percentage,
          captain_percentage,
          vice_captain_percentage,
          effective_ownership_percentage
        FROM reporting.tournament_selection_stats
        WHERE tournament_id = ${TOURNAMENT_ID}
          AND season_id = ${SEASON_ID}
          AND event_id = ${EVENT_ID}
          AND element_id = ${PLAYER_IDS[0]}
      `;
      return rows[0];
    };

    const bothEntries = await readPlayer();
    expect(bothEntries).toMatchObject({
      total_entries: 2,
      selected_count: 2,
      captain_count: 1,
      vice_captain_count: 1,
      effective_selection_count: 3,
    });
    expect(Number(bothEntries?.selection_percentage)).toBe(100);
    expect(Number(bothEntries?.captain_percentage)).toBe(50);
    expect(Number(bothEntries?.vice_captain_percentage)).toBe(50);
    expect(Number(bothEntries?.effective_ownership_percentage)).toBe(150);

    await sql`
      UPDATE competition.entries
      SET started_event = 2
      WHERE season_id = ${SEASON_ID}
        AND entry_id = ${ENTRY_IDS[1]}
    `;
    await refreshTournamentSelectionStatsMaterializedView();
    const eligibleEntryOnly = await readPlayer();
    expect(eligibleEntryOnly).toMatchObject({
      total_entries: 1,
      selected_count: 1,
      captain_count: 1,
      vice_captain_count: 0,
      effective_selection_count: 2,
    });
    expect(Number(eligibleEntryOnly?.selection_percentage)).toBe(100);
    expect(Number(eligibleEntryOnly?.effective_ownership_percentage)).toBe(200);

    await sql`
      UPDATE competition.entries
      SET started_event = 1,
          transfers_synced_through_event_id = CASE
            WHEN entry_id = ${ENTRY_IDS[1]} THEN NULL
            ELSE transfers_synced_through_event_id
          END
      WHERE season_id = ${SEASON_ID}
        AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
    `;
    await expect(
      syncTournamentSelectionStats(season, EVENT_ID, { tournamentIds: [TOURNAMENT_ID] }),
    ).rejects.toBeInstanceOf(IncompleteDataSyncError);
    await refreshTournamentSelectionStatsMaterializedView();
    const checkpointBlocked = await sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM reporting.tournament_selection_stats
      WHERE tournament_id = ${TOURNAMENT_ID}
        AND event_id = ${EVENT_ID}
    `;
    expect(checkpointBlocked[0]?.count).toBe(0);

    await sql`
      UPDATE competition.entries
      SET transfers_synced_through_event_id = 1
      WHERE season_id = ${SEASON_ID}
        AND entry_id = ${ENTRY_IDS[1]}
    `;
    await refreshTournamentSelectionStatsMaterializedView();
    await sql`
      DELETE FROM competition.entry_event_picks
      WHERE season_id = ${SEASON_ID}
        AND entry_id = ${ENTRY_IDS[1]}
        AND event_id = ${EVENT_ID}
        AND position = 15
    `;
    await expect(
      syncTournamentSelectionStats(season, EVENT_ID, { tournamentIds: [TOURNAMENT_ID] }),
    ).rejects.toBeInstanceOf(IncompleteDataSyncError);
    await refreshTournamentSelectionStatsMaterializedView();
    const picksBlocked = await sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM reporting.tournament_selection_stats
      WHERE tournament_id = ${TOURNAMENT_ID}
        AND event_id = ${EVENT_ID}
    `;
    expect(picksBlocked[0]?.count).toBe(0);
  });
});
