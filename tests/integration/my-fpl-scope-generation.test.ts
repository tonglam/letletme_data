import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';

const SEASON_ID = 9395;
const SEASON_CODE = '9395';
const EVENT_ID = 1;
const REVISION = 9_395_001;

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM competition.my_fpl_snapshot_publications
    WHERE season_id = ${SEASON_ID}
  `;
  await sql`
    DELETE FROM fpl.events
    WHERE season_id = ${SEASON_ID}
  `;
  await sql`
    DELETE FROM fpl.seasons
    WHERE season_id = ${SEASON_ID}
  `;
}

async function seed(): Promise<void> {
  const sql = await getDbClient();
  await cleanup();
  await sql`
    INSERT INTO fpl.seasons (
      season_id, season_code, display_name, start_year, end_year,
      lifecycle_state, is_current
    ) VALUES (
      ${SEASON_ID}, ${SEASON_CODE}, 'My FPL scope generation integration',
      9395, 9396, 'completed', false
    )
  `;
  await sql`
    INSERT INTO fpl.events (
      season_id, event_id, name, deadline_time, finished, data_checked,
      data_checked_at
    ) VALUES (
      ${SEASON_ID}, ${EVENT_ID}, 'Scope generation GW 1',
      timestamptz '2026-08-22 04:00:00+00', true, true,
      timestamptz '2026-08-23 00:00:00+00'
    )
  `;
  await sql`
    INSERT INTO competition.my_fpl_snapshot_publications (
      season_id, event_id, revision, snapshot_date, source_checked_at,
      published_at, kind, active, expected_entry_count, ready_entry_count,
      empty_entry_count, expected_tournament_count, ready_tournament_count,
      content_sha256, entry_scope_sha256, tournament_scope_sha256
    ) VALUES (
      ${SEASON_ID}, ${EVENT_ID}, ${REVISION}, '2026-08-23', now(), now(),
      'FINAL', true, 0, 0, 0, 0, 0,
      repeat('a', 64), repeat('b', 64), repeat('c', 64)
    )
  `;
  await sql`
    UPDATE competition.my_fpl_snapshot_scope_state
    SET verified_entry_scope_generation = entry_scope_generation,
        verified_tournament_scope_generation = tournament_scope_generation,
        entry_dirty_since = NULL,
        tournament_dirty_since = NULL,
        verified_revision = ${REVISION},
        verified_at = now(),
        updated_at = now()
    WHERE season_id = ${SEASON_ID} AND event_id = ${EVENT_ID}
  `;
}

beforeAll(seed);
afterAll(cleanup);

describe('My FPL scope-generation event fence', () => {
  test('invalidates both verified scope families when a final event reopens and refinalizes', async () => {
    const sql = await getDbClient();
    const initial = await sql<
      Array<{
        entry_scope_generation: number;
        verified_entry_scope_generation: number;
        tournament_scope_generation: number;
        verified_tournament_scope_generation: number;
        verified_revision: number;
      }>
    >`
      SELECT entry_scope_generation::integer, verified_entry_scope_generation::integer,
             tournament_scope_generation::integer, verified_tournament_scope_generation::integer,
             verified_revision::integer
      FROM competition.my_fpl_snapshot_scope_state
      WHERE season_id = ${SEASON_ID} AND event_id = ${EVENT_ID}
    `;
    expect(initial[0]).toMatchObject({
      entry_scope_generation: 0,
      verified_entry_scope_generation: 0,
      tournament_scope_generation: 0,
      verified_tournament_scope_generation: 0,
      verified_revision: REVISION,
    });

    await sql`
      UPDATE fpl.events
      SET finished = false, data_checked = false
      WHERE season_id = ${SEASON_ID} AND event_id = ${EVENT_ID}
    `;
    const reopened = await sql<
      Array<{
        entry_scope_generation: number;
        verified_entry_scope_generation: number;
        tournament_scope_generation: number;
        verified_tournament_scope_generation: number;
        verified_revision: number | null;
        entry_dirty: boolean;
        tournament_dirty: boolean;
      }>
    >`
      SELECT entry_scope_generation::integer, verified_entry_scope_generation::integer,
             tournament_scope_generation::integer, verified_tournament_scope_generation::integer,
             verified_revision::integer,
             entry_dirty_since IS NOT NULL AS entry_dirty,
             tournament_dirty_since IS NOT NULL AS tournament_dirty
      FROM competition.my_fpl_snapshot_scope_state
      WHERE season_id = ${SEASON_ID} AND event_id = ${EVENT_ID}
    `;
    expect(reopened[0]).toMatchObject({
      entry_scope_generation: 1,
      verified_entry_scope_generation: 0,
      tournament_scope_generation: 1,
      verified_tournament_scope_generation: 0,
      verified_revision: null,
    });
    expect(reopened[0]).toMatchObject({ entry_dirty: true, tournament_dirty: true });

    await sql`
      UPDATE fpl.events
      SET finished = true, data_checked = true,
          data_checked_at = timestamptz '2026-08-24 00:00:00+00'
      WHERE season_id = ${SEASON_ID} AND event_id = ${EVENT_ID}
    `;
    const refinalized = await sql<
      Array<{
        entry_scope_generation: number;
        verified_entry_scope_generation: number;
        tournament_scope_generation: number;
        verified_tournament_scope_generation: number;
        verified_revision: number | null;
      }>
    >`
      SELECT entry_scope_generation::integer, verified_entry_scope_generation::integer,
             tournament_scope_generation::integer, verified_tournament_scope_generation::integer,
             verified_revision::integer
      FROM competition.my_fpl_snapshot_scope_state
      WHERE season_id = ${SEASON_ID} AND event_id = ${EVENT_ID}
    `;
    expect(refinalized[0]).toEqual({
      entry_scope_generation: 2,
      verified_entry_scope_generation: 0,
      tournament_scope_generation: 2,
      verified_tournament_scope_generation: 0,
      verified_revision: null,
    });
  });
});
