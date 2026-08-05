import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  replaceSelectionStats,
  type TournamentSelectionStatRow,
} from '../../src/services/tournament-selection-stats.service';

const EVENT_ID = 1;
const TEAM_ID = 99_044_001;
const PLAYER_ONE = 99_044_011;
const PLAYER_TWO = 99_044_012;
const INVALID_PLAYER = 99_044_099;
const TOURNAMENT_NAME = 'Selection Stats Atomicity 99044001';
let tournamentId = 0;

function stat(elementId: number, pickCount: number): TournamentSelectionStatRow {
  return {
    tournamentId,
    eventId: EVENT_ID,
    elementId,
    pickCount,
    captainCount: 0,
    viceCaptainCount: 0,
    transferInCount: 0,
    transferOutCount: 0,
    totalEntries: 2,
  };
}

async function storedRows() {
  const sql = await getDbClient();
  const rows = await sql<{ element_id: number; pick_count: number }[]>`
    SELECT element_id, pick_count
    FROM tournament_selection_stats
    WHERE tournament_id = ${tournamentId} AND event_id = ${EVENT_ID}
    ORDER BY element_id
  `;
  return rows.map((row) => ({
    element_id: Number(row.element_id),
    pick_count: Number(row.pick_count),
  }));
}

beforeAll(async () => {
  const sql = await getDbClient();
  await sql`INSERT INTO events (id, name) VALUES (${EVENT_ID}, 'Selection stats GW') ON CONFLICT (id) DO NOTHING`;
  await sql`
    INSERT INTO teams (id, code, name, short_name, pulse_id)
    VALUES (${TEAM_ID}, ${TEAM_ID}, 'Selection Test', 'SEL', ${TEAM_ID})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO players (id, code, type, team_id, web_name)
    VALUES
      (${PLAYER_ONE}, ${PLAYER_ONE}, 1, ${TEAM_ID}, 'Selection One'),
      (${PLAYER_TWO}, ${PLAYER_TWO}, 2, ${TEAM_ID}, 'Selection Two')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`DELETE FROM tournament_infos WHERE name = ${TOURNAMENT_NAME}`;
  const created = await sql<{ id: number }[]>`
    INSERT INTO tournament_infos (
      name, creator, admin_entry_id, league_id, league_type, total_team_num,
      tournament_mode, group_mode, knockout_mode, state
    ) VALUES (
      ${TOURNAMENT_NAME}, 'Integration', 99044001, 99044001, 'classic', 2,
      'normal', 'no_group', 'no_knockout', 'active'
    )
    RETURNING id
  `;
  tournamentId = created[0].id;
});

afterAll(async () => {
  const sql = await getDbClient();
  if (tournamentId > 0) {
    await sql`DELETE FROM tournament_infos WHERE id = ${tournamentId}`;
  }
  await sql`DELETE FROM players WHERE id IN (${PLAYER_ONE}, ${PLAYER_TWO})`;
  await sql`DELETE FROM teams WHERE id = ${TEAM_ID}`;
});

describe('tournament selection-stat publication', () => {
  test('rolls back delete-and-replace on failure, then removes stale rows on success', async () => {
    expect(await replaceSelectionStats([tournamentId], EVENT_ID, [stat(PLAYER_ONE, 2)])).toBe(1);
    expect(await storedRows()).toEqual([{ element_id: PLAYER_ONE, pick_count: 2 }]);

    await expect(
      replaceSelectionStats([tournamentId], EVENT_ID, [
        stat(PLAYER_TWO, 1),
        stat(INVALID_PLAYER, 1),
      ]),
    ).rejects.toThrow();
    expect(await storedRows()).toEqual([{ element_id: PLAYER_ONE, pick_count: 2 }]);

    expect(await replaceSelectionStats([tournamentId], EVENT_ID, [stat(PLAYER_TWO, 2)])).toBe(1);
    expect(await storedRows()).toEqual([{ element_id: PLAYER_TWO, pick_count: 2 }]);
  });
});
