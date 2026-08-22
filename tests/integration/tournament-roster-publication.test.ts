import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import { tournamentRosterRepository } from '../../src/repositories/tournament-roster';
import { withMutationScopes } from '../../src/utils/mutation-scopes';

const SEASON_CODE = '8990';
const SEASON_ID = explicitSeasonRef(SEASON_CODE).seasonId;
const TOURNAMENT_ID = 991_951;
const LEAGUE_ID = 991_951;
const ENTRY_IDS = [991_951, 991_952, 991_953] as const;

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM competition.tournament_entries
    WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
  `;
  await sql`DELETE FROM competition.tournaments WHERE tournament_id = ${TOURNAMENT_ID}`;
  await sql`
    DELETE FROM competition.entries
    WHERE season_id = ${SEASON_ID} AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
  `;
  await sql`DELETE FROM fpl.seasons WHERE season_id = ${SEASON_ID}`;
}

async function seed(): Promise<void> {
  const sql = await getDbClient();
  await cleanup();
  await sql`
    INSERT INTO fpl.seasons (
      season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
    ) VALUES (
      ${SEASON_ID}, ${SEASON_CODE}, 'Roster publication integration',
      ${SEASON_ID}, ${SEASON_ID + 1}, 'active', true
    )
  `;
  await sql`
    INSERT INTO competition.entries (season_id, entry_id, entry_name, player_name)
    SELECT
      ${SEASON_ID}, entry_id, 'Existing Entry ' || entry_id::text,
      'Existing Manager ' || entry_id::text
    FROM unnest(${[...ENTRY_IDS.slice(0, 2)]}::integer[]) AS entries(entry_id)
  `;
  await sql`
    INSERT INTO competition.tournaments (
      tournament_id, season_id, name, creator, admin_entry_id, league_id, league_type,
      total_team_num, tournament_mode, group_mode, group_auto_averages, state,
      roster_mode, roster_sync_status, setup_status
    ) VALUES (
      ${TOURNAMENT_ID}, ${SEASON_ID}, 'Roster publication integration', 'integration-test',
      ${ENTRY_IDS[0]}, ${LEAGUE_ID}, 'h2h', 2, 'normal', 'no_group', false, 'active',
      'official_sync', 'processing', 'ready'
    )
  `;
  await sql`
    INSERT INTO competition.tournament_entries (tournament_id, season_id, league_id, entry_id)
    SELECT ${TOURNAMENT_ID}, ${SEASON_ID}, ${LEAGUE_ID}, entry_id
    FROM unnest(${[...ENTRY_IDS.slice(0, 2)]}::integer[]) AS entries(entry_id)
  `;
}

beforeEach(seed);
afterEach(cleanup);

describe('authoritative tournament roster publication', () => {
  test('replaces tournament-owned structure and publishes newly joined entries', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const tournament = await tournamentRosterRepository.findById(season, TOURNAMENT_ID);
    expect(tournament).not.toBeNull();

    const result = await tournamentRosterRepository.publishAuthoritativeRoster(
      season,
      tournament!,
      ENTRY_IDS.map((entryId) => ({
        id: String(entryId),
        team: `Published Entry ${entryId}`,
        manager: `Published Manager ${entryId}`,
        overallRank: entryId,
        totalPoints: 0,
      })),
      'Published H2H League',
    );

    expect(result).toEqual({
      changed: true,
      participantCount: ENTRY_IDS.length,
      automaticallyPaused: false,
      skipped: false,
    });

    const sql = await getDbClient();
    const entries = await sql<Array<{ entry_id: number }>>`
      SELECT entry_id
      FROM competition.tournament_entries
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
      ORDER BY entry_id
    `;
    expect(entries.map((entry) => entry.entry_id)).toEqual([...ENTRY_IDS]);

    const [published] = await sql<
      Array<{
        total_team_num: number;
        source_league_name: string | null;
        roster_sync_status: string | null;
        setup_status: string;
      }>
    >`
      SELECT total_team_num, source_league_name, roster_sync_status, setup_status
      FROM competition.tournaments
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    expect(published).toEqual({
      total_team_num: ENTRY_IDS.length,
      source_league_name: 'Published H2H League',
      roster_sync_status: 'ready',
      setup_status: 'pending',
    });
  });

  test('fences a ready official H2H roster before a recovery worker claims it', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    await sql`
      UPDATE competition.tournaments
      SET group_mode = 'battle_races', roster_sync_status = 'ready'
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;

    const marker = await tournamentRosterRepository.prepareUnlockedOfficialH2HRecovery(
      season,
      TOURNAMENT_ID,
    );
    expect(marker).toBeString();

    const [prepared] = await sql<Array<{ rosterSyncStatus: string | null; marker: string | null }>>`
      SELECT
        roster_sync_status AS "rosterSyncStatus",
        setup_progress_updated_at::text AS marker
      FROM competition.tournaments
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    expect(prepared).toEqual({ rosterSyncStatus: 'failed', marker });
    expect(
      await tournamentRosterRepository.claimUnlockedOfficialH2HRecovery(
        season,
        TOURNAMENT_ID,
        marker!,
      ),
    ).toBe(true);
    expect(
      await tournamentRosterRepository.claimUnlockedOfficialH2HRecovery(
        season,
        TOURNAMENT_ID,
        marker!,
      ),
    ).toBe(false);
  });

  test('publishes an additive recovery inside its production mutation scope', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    await sql`
      UPDATE competition.tournaments
      SET group_mode = 'battle_races', roster_sync_status = 'ready'
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    const marker = await tournamentRosterRepository.prepareUnlockedOfficialH2HRecovery(
      season,
      TOURNAMENT_ID,
    );
    expect(marker).toBeString();
    expect(
      await tournamentRosterRepository.claimUnlockedOfficialH2HRecovery(
        season,
        TOURNAMENT_ID,
        marker!,
      ),
    ).toBe(true);
    const tournament = await tournamentRosterRepository.findById(season, TOURNAMENT_ID);
    expect(tournament).not.toBeNull();

    const result = await withMutationScopes(
      {
        queueName: 'integration-test',
        jobName: 'publish-authoritative-roster',
        scopes: [`integration:tournament-roster:${TOURNAMENT_ID}`],
      },
      () =>
        tournamentRosterRepository.publishAuthoritativeRoster(
          season,
          tournament!,
          ENTRY_IDS.map((entryId) => ({
            id: String(entryId),
            team: `Recovered Entry ${entryId}`,
            manager: `Recovered Manager ${entryId}`,
            overallRank: entryId,
            totalPoints: 0,
          })),
          'Recovered H2H League',
          {
            expectedProgressMarker: marker,
            guardUnlockedOfficialH2HRecovery: true,
          },
        ),
    );
    expect(result.changed).toBe(true);
    expect(result.participantCount).toBe(ENTRY_IDS.length);
  });

  test('rejects guarded recovery removals inside the publication transaction', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    const [prepared] = await sql<Array<{ marker: string }>>`
      UPDATE competition.tournaments
      SET group_mode = 'battle_races',
          roster_sync_status = 'processing',
          setup_progress_updated_at = now()
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
      RETURNING setup_progress_updated_at::text AS marker
    `;
    const tournament = await tournamentRosterRepository.findById(season, TOURNAMENT_ID);
    expect(tournament).not.toBeNull();

    await expect(
      tournamentRosterRepository.publishAuthoritativeRoster(
        season,
        tournament!,
        [
          {
            id: String(ENTRY_IDS[0]),
            team: 'Removal Attempt',
            manager: 'Removal Attempt',
            overallRank: ENTRY_IDS[0],
            totalPoints: 0,
          },
        ],
        'Unsafe H2H League',
        {
          expectedProgressMarker: prepared!.marker,
          guardUnlockedOfficialH2HRecovery: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'TOURNAMENT_OFFICIAL_H2H_RECOVERY_NOT_ADDITIVE' });
  });

  test('rejects publication when the official schedule locks after recovery claim', async () => {
    const season = explicitSeasonRef(SEASON_CODE);
    const sql = await getDbClient();
    await sql`
      UPDATE competition.tournaments
      SET group_mode = 'battle_races', roster_sync_status = 'ready'
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    const marker = await tournamentRosterRepository.prepareUnlockedOfficialH2HRecovery(
      season,
      TOURNAMENT_ID,
    );
    expect(marker).toBeString();
    expect(
      await tournamentRosterRepository.claimUnlockedOfficialH2HRecovery(
        season,
        TOURNAMENT_ID,
        marker!,
      ),
    ).toBe(true);
    await sql`
      UPDATE competition.tournaments
      SET official_schedule_locked_at = now()
      WHERE season_id = ${SEASON_ID} AND tournament_id = ${TOURNAMENT_ID}
    `;
    const tournament = await tournamentRosterRepository.findById(season, TOURNAMENT_ID);
    expect(tournament).not.toBeNull();

    await expect(
      tournamentRosterRepository.publishAuthoritativeRoster(
        season,
        tournament!,
        ENTRY_IDS.map((entryId) => ({
          id: String(entryId),
          team: `Late Entry ${entryId}`,
          manager: `Late Manager ${entryId}`,
          overallRank: entryId,
          totalPoints: 0,
        })),
        'Locked H2H League',
        {
          expectedProgressMarker: marker,
          guardUnlockedOfficialH2HRecovery: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'TOURNAMENT_OFFICIAL_H2H_RECOVERY_UNSAFE' });
  });
});
