import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import { createTournamentSetupIssueRepository } from '../../src/repositories/tournament-setup-issues';

const SEASON_CODE = '9192';
const SEASON_ID = explicitSeasonRef(SEASON_CODE).seasonId;
const TOURNAMENT_ID = 991_801;
const ADMIN_ENTRY_ID = 991_801;
const ENTRY_IDS = [991_801, 991_802, 991_803] as const;
const LEAGUE_ID = 991_801;

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM competition.entry_event_pick_heads
    WHERE season_id = ${SEASON_ID} AND entry_id = ANY(${sql.array([...ENTRY_IDS])}::integer[])
  `;
  await sql`
    DELETE FROM competition.entry_event_pick_repairs
    WHERE season_id = ${SEASON_ID} AND entry_id = ANY(${sql.array([...ENTRY_IDS])}::integer[])
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
    DELETE FROM fpl.seasons
    WHERE season_id = ${SEASON_ID}
  `;
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
      ${SEASON_CODE},
      'Tournament setup issue integration',
      ${SEASON_ID},
      ${SEASON_ID + 1},
      'completed',
      false
    )
  `;
  await sql`
    INSERT INTO competition.entries (season_id, entry_id, entry_name, player_name)
    SELECT ${SEASON_ID}, entry_id, 'Setup Entry ' || entry_id::text, 'Setup Manager ' || entry_id::text
    FROM unnest(${[...ENTRY_IDS]}::integer[]) AS entries(entry_id)
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
      'Tournament setup issue integration',
      'integration-test',
      ${ADMIN_ENTRY_ID},
      ${LEAGUE_ID},
      'classic',
      ${ENTRY_IDS.length},
      'normal',
      'no_group',
      false,
      'active'
    )
  `;
}

beforeAll(seed);
afterAll(cleanup);

describe('tournament setup issue persistence', () => {
  test('binds empty, single, and multiple entry arrays and resolves omitted keys', async () => {
    const sql = await getDbClient();
    const season = explicitSeasonRef(SEASON_CODE);
    const repository = createTournamentSetupIssueRepository();
    const profileIssue = {
      issueKey: 'ENTRY_PROFILE_INCOMPLETE:all',
      code: 'ENTRY_PROFILE_INCOMPLETE' as const,
      category: 'profiles' as const,
      severity: 'warning' as const,
      affectedEntryIds: [...ENTRY_IDS],
    };
    const resultIssue = {
      issueKey: 'TOURNAMENT_RESULTS_INCOMPLETE:1',
      code: 'TOURNAMENT_RESULTS_INCOMPLETE' as const,
      category: 'results' as const,
      severity: 'warning' as const,
      eventId: 1,
      affectedEntryIds: [],
    };

    await expect(
      repository.sync(season, TOURNAMENT_ID, [profileIssue, resultIssue]),
    ).resolves.toEqual({ warningCount: 2, unresolvedCount: 2 });

    const firstRows = await sql<
      Array<{ issue_key: string; affected_entry_ids: number[]; affected_entry_count: number }>
    >`
      SELECT
        issue_key,
        affected_entry_ids,
        affected_entry_count
      FROM competition.tournament_setup_issues
      WHERE season_id = ${SEASON_ID}
        AND tournament_id = ${TOURNAMENT_ID}
      ORDER BY issue_key
    `;
    expect([...firstRows]).toEqual([
      {
        issue_key: 'ENTRY_PROFILE_INCOMPLETE:all',
        affected_entry_ids: [...ENTRY_IDS],
        affected_entry_count: 3,
      },
      {
        issue_key: 'TOURNAMENT_RESULTS_INCOMPLETE:1',
        affected_entry_ids: [],
        affected_entry_count: 0,
      },
    ]);

    await expect(
      repository.sync(season, TOURNAMENT_ID, [
        { ...profileIssue, affectedEntryIds: [ENTRY_IDS[1], ENTRY_IDS[1]] },
        resultIssue,
      ]),
    ).resolves.toEqual({ warningCount: 2, unresolvedCount: 2 });

    const updated = await sql<
      Array<{ issue_key: string; affected_entry_ids: number[]; affected_entry_count: number }>
    >`
      SELECT issue_key, affected_entry_ids, affected_entry_count
      FROM competition.tournament_setup_issues
      WHERE season_id = ${SEASON_ID}
        AND tournament_id = ${TOURNAMENT_ID}
        AND issue_key = 'ENTRY_PROFILE_INCOMPLETE:all'
    `;
    expect([...updated]).toEqual([
      {
        issue_key: 'ENTRY_PROFILE_INCOMPLETE:all',
        affected_entry_ids: [ENTRY_IDS[1]],
        affected_entry_count: 1,
      },
    ]);

    await expect(repository.sync(season, TOURNAMENT_ID, [profileIssue])).resolves.toEqual({
      warningCount: 1,
      unresolvedCount: 1,
    });
    const resolvedRows = await sql<Array<{ issue_key: string; resolved_at: string | null }>>`
      SELECT issue_key, resolved_at::text
      FROM competition.tournament_setup_issues
      WHERE season_id = ${SEASON_ID}
        AND tournament_id = ${TOURNAMENT_ID}
      ORDER BY issue_key
    `;
    expect(resolvedRows).toHaveLength(2);
    expect(resolvedRows[0]?.resolved_at).toBeNull();
    expect(resolvedRows[1]?.resolved_at).not.toBeNull();

    await expect(repository.sync(season, TOURNAMENT_ID, [])).resolves.toEqual({
      warningCount: 0,
      unresolvedCount: 0,
    });
  });
});
