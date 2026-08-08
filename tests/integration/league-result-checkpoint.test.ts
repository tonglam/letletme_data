import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import { leagueEventResultsRepository } from '../../src/repositories/league-event-results';

const ENTRY_ID = 99_043_250;
const LEAGUE_ID = 9_904_325;
const EVENT_ID = 1;

const row = {
  leagueId: LEAGUE_ID,
  leagueType: 'classic' as const,
  eventId: EVENT_ID,
  entryId: ENTRY_ID,
  entryName: 'Checkpoint entry',
  playerName: 'Checkpoint manager',
  overallPoints: 50,
  overallRank: 100,
  eventPoints: 50,
  eventTransfers: 0,
  eventTransfersCost: 0,
  eventNetPoints: 50,
};

describe('league result attempt checkpoint', () => {
  beforeAll(async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO events (id, name)
      VALUES (${EVENT_ID}, 'League checkpoint GW')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO entry_infos (id, entry_name, player_name)
      VALUES (${ENTRY_ID}, 'Checkpoint entry', 'Checkpoint manager')
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM league_event_results WHERE entry_id = ${ENTRY_ID}`;
    await sql`DELETE FROM entry_infos WHERE id = ${ENTRY_ID}`;
  });

  test('reuses only rows whose source evidence belongs to the current attempt', async () => {
    const oldEvidence = new Date('2026-08-04T08:00:00.000Z');
    const laterRun = new Date('2026-08-04T09:00:00.000Z');
    await leagueEventResultsRepository.upsertBatch([{ ...row, sourceCheckedAt: oldEvidence }]);
    const sql = await getDbClient();
    await sql`
      UPDATE league_event_results
      SET updated_at = '2026-08-04T10:00:00.000Z'
      WHERE entry_id = ${ENTRY_ID}
    `;
    expect(
      await leagueEventResultsRepository.findEntryIdsByLeagueEvent(
        LEAGUE_ID,
        'classic',
        EVENT_ID,
        [ENTRY_ID],
        laterRun,
      ),
    ).toEqual([]);

    const currentRun = '2026-08-04T11:00:00.000900Z';
    const olderSameMillisecond = '2026-08-04T11:00:00.000100Z';
    expect(new Date(currentRun).getTime()).toBe(new Date(olderSameMillisecond).getTime());
    await leagueEventResultsRepository.upsertBatch([
      { ...row, eventPoints: 55, sourceCheckedAt: currentRun },
    ]);
    expect(
      await leagueEventResultsRepository.findEntryIdsByLeagueEvent(
        LEAGUE_ID,
        'classic',
        EVENT_ID,
        [ENTRY_ID],
        new Date(currentRun),
      ),
    ).toEqual([ENTRY_ID]);

    await leagueEventResultsRepository.upsertBatch([
      { ...row, eventPoints: 1, sourceCheckedAt: olderSameMillisecond },
    ]);
    await leagueEventResultsRepository.upsertBatch([
      { ...row, eventPoints: 2, sourceCheckedAt: currentRun },
    ]);
    const preserved = await sql<{ eventPoints: number; sourceMatches: boolean }[]>`
      SELECT
        event_points AS "eventPoints",
        source_checked_at = ${currentRun}::timestamptz AS "sourceMatches"
      FROM league_event_results
      WHERE entry_id = ${ENTRY_ID}
    `;
    expect(Array.from(preserved)).toEqual([{ eventPoints: 55, sourceMatches: true }]);
  });
});
