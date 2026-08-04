import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { planTournamentStructure, type TournamentParticipant } from '../../src/domain/tournament';
import { getDbClient } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { tournamentManagementRepository } from '../../src/repositories/tournament-management';
import { tournamentRosterRepository } from '../../src/repositories/tournament-roster';

/**
 * FP-08 (C5): tournament creation must not poison entry_infos.
 * An entry that the FPL detail sync already populated (real overall_rank /
 * overall_points) must survive createTournamentWithEntries untouched.
 */

const ENTRY_BASE = 99000201;
const SYNCED_ENTRY = {
  id: ENTRY_BASE,
  entryName: 'Synced Team Name',
  playerName: 'Synced Manager',
  overallRank: 777,
  overallPoints: 4321,
};

const createdTournamentIds: number[] = [];

beforeAll(async () => {
  const client = await getDbClient();
  await client`
    INSERT INTO events (id, name)
    SELECT event_id, 'Tournament lifecycle GW' || event_id
    FROM generate_series(1, 38) AS generated(event_id)
    ON CONFLICT (id) DO NOTHING
  `;
});

afterAll(async () => {
  const client = await getDbClient();
  await client.begin(async (tx) => {
    for (const tournamentId of createdTournamentIds) {
      await tx`DELETE FROM tournament_entries WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_infos WHERE id = ${tournamentId}`;
    }
    await tx`DELETE FROM entry_infos WHERE id >= ${ENTRY_BASE} AND id < ${ENTRY_BASE + 100}`;
  });
});

function buildParticipants(): TournamentParticipant[] {
  return [
    {
      id: String(SYNCED_ENTRY.id),
      team: 'Standings Team Name',
      manager: 'Standings Manager',
      overallRank: 999999,
      totalPoints: 0,
    },
    ...[1, 2, 3].map((index) => ({
      id: String(ENTRY_BASE + index),
      team: `New Team ${index}`,
      manager: `New Manager ${index}`,
      overallRank: index,
      totalPoints: 100 + index,
    })),
  ];
}

describe('tournament creation vs entry_infos (FP-08)', () => {
  test('watchdog cutoff query binds safely against PostgreSQL', async () => {
    const rows = await tournamentInfoRepository.findStuckProcessing(15);

    expect(Array.isArray(rows)).toBe(true);
  });

  test(
    'existing synced entries keep their rank/points; new entries get stub rows',
    async () => {
      const client = await getDbClient();

      // Given: an entry the FPL detail sync already populated
      await client`
        INSERT INTO entry_infos (id, entry_name, player_name, overall_rank, overall_points)
        VALUES (${SYNCED_ENTRY.id}, ${SYNCED_ENTRY.entryName}, ${SYNCED_ENTRY.playerName},
                ${SYNCED_ENTRY.overallRank}, ${SYNCED_ENTRY.overallPoints})
        ON CONFLICT (id) DO NOTHING
      `;

      // When: a tournament is created including that entry (with stale
      // league-standings values for it, as the create flow provides)
      const participants = buildParticipants();
      const plan = planTournamentStructure(
        {
          tournamentName: `FP-08 Poison Test ${Date.now()}`,
          adminId: String(SYNCED_ENTRY.id),
          creator: 'fp-08-test',
          participantSource: 'custom',
          leagueUrl: 'https://fantasy.premierleague.com/leagues/900002/standings/c',
          groupFormat: 'points',
          startGameweek: 'GW1',
          endGameweek: 'GW38',
          groupNum: '1',
          qualifiersPerGroup: '4',
          knockoutFormat: 'none',
          selectedParticipantIds: participants.map((p) => p.id),
        },
        participants,
        900002,
        'classic',
      );
      const created = await tournamentInfoRepository.createTournamentWithEntries(plan);
      createdTournamentIds.push(created.id);

      // Then: the pre-synced entry is untouched
      const rows = await client`
        SELECT entry_name, player_name, overall_rank, overall_points
        FROM entry_infos WHERE id = ${SYNCED_ENTRY.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entry_name: SYNCED_ENTRY.entryName,
        player_name: SYNCED_ENTRY.playerName,
        overall_rank: SYNCED_ENTRY.overallRank,
        overall_points: SYNCED_ENTRY.overallPoints,
      });

      // And: never-seen participants still get their stub rows
      const stubs = await client`
        SELECT id, overall_points FROM entry_infos
        WHERE id IN (${ENTRY_BASE + 1}, ${ENTRY_BASE + 2}, ${ENTRY_BASE + 3})
        ORDER BY id
      `;
      expect(stubs).toHaveLength(3);
      expect(stubs[0]).toMatchObject({ id: ENTRY_BASE + 1, overall_points: 101 });
    },
    { timeout: 30_000 },
  );

  test('records the authoritative roster as ready for an official-sync shell', async () => {
    const client = await getDbClient();
    const participants = buildParticipants();
    const plan = planTournamentStructure(
      {
        tournamentName: `Official Sync Shell ${Date.now()}`,
        adminId: String(SYNCED_ENTRY.id),
        creator: 'official-sync-test',
        participantSource: 'official',
        leagueUrl: 'https://fantasy.premierleague.com/leagues/900003/standings/c',
        groupFormat: 'points',
        startGameweek: 'GW1',
        endGameweek: 'GW38',
        groupNum: '1',
        qualifiersPerGroup: '',
        knockoutFormat: 'none',
      },
      participants,
      900003,
      'classic',
      'Official Source League',
    );

    const created = await tournamentInfoRepository.createTournamentWithEntries(plan);
    createdTournamentIds.push(created.id);
    const rows = await client<
      Array<{
        roster_mode: string;
        roster_sync_status: string | null;
        roster_last_synced_at: Date | null;
        source_league_name: string | null;
      }>
    >`
      select roster_mode, roster_sync_status, roster_last_synced_at, source_league_name
      from tournament_infos
      where id = ${created.id}
    `;

    expect(rows[0]).toMatchObject({
      roster_mode: 'official_sync',
      roster_sync_status: 'ready',
      source_league_name: 'Official Source League',
    });
    expect(rows[0]?.roster_last_synced_at).not.toBeNull();

    await client`
      update tournament_infos
      set state = 'inactive', roster_sync_status = 'processing'
      where id = ${created.id}
    `;
    await tournamentRosterRepository.markReadyAndResume(created.id);

    const resumed = await client<Array<{ state: string; roster_sync_status: string }>>`
      select state, roster_sync_status
      from tournament_infos
      where id = ${created.id}
    `;
    expect(resumed[0]).toEqual({ state: 'active', roster_sync_status: 'ready' });

    await client`
      update tournament_infos
      set state = 'inactive', roster_sync_status = 'processing'
      where id = ${created.id}
    `;
    await tournamentManagementRepository.updateStateOwned(created.id, SYNCED_ENTRY.id, 'inactive');
    await tournamentRosterRepository.markReadyAndResume(created.id);

    const pauseWins = await client<Array<{ state: string; roster_sync_status: string }>>`
      select state, roster_sync_status
      from tournament_infos
      where id = ${created.id}
    `;
    expect(pauseWins[0]).toEqual({ state: 'inactive', roster_sync_status: 'ready' });

    await client`
      update tournament_infos
      set state = 'inactive', roster_sync_status = 'processing'
      where id = ${created.id}
    `;
    const cancelledResumeRecord = await tournamentRosterRepository.findById(created.id);
    if (!cancelledResumeRecord) throw new Error('Expected tournament roster record');
    await tournamentManagementRepository.updateStateOwned(created.id, SYNCED_ENTRY.id, 'inactive');
    const cancelledPublication = await tournamentRosterRepository.publishAuthoritativeRoster(
      cancelledResumeRecord,
      participants,
      'Official Source League',
      { allowInactive: true, resumeAfterSetup: true },
    );
    expect(cancelledPublication.skipped).toBe(true);

    await client`
      update tournament_infos
      set state = 'inactive', roster_sync_status = 'processing'
      where id = ${created.id}
    `;
    const uninterruptedResumeRecord = await tournamentRosterRepository.findById(created.id);
    if (!uninterruptedResumeRecord) throw new Error('Expected tournament roster record');
    const uninterruptedPublication = await tournamentRosterRepository.publishAuthoritativeRoster(
      uninterruptedResumeRecord,
      participants,
      'Official Source League',
      { allowInactive: true, resumeAfterSetup: true },
    );
    expect(uninterruptedPublication.skipped).toBe(false);
    const resumeMarker = await client<Array<{ roster_sync_status: string }>>`
      select roster_sync_status
      from tournament_infos
      where id = ${created.id}
    `;
    expect(resumeMarker[0]?.roster_sync_status).toBe('processing');

    await client`
      update tournament_infos
      set state = 'active',
          setup_status = 'ready',
          setup_phase = 'ready',
          standings_ready_at = now()
      where id = ${created.id}
    `;
    await tournamentInfoRepository.markSetupRetryQueued(created.id);

    const retryGate = await client<
      Array<{ setup_status: string; setup_phase: string; standings_ready_at: Date | null }>
    >`
      select setup_status, setup_phase, standings_ready_at
      from tournament_infos
      where id = ${created.id}
    `;
    expect(retryGate[0]).toEqual({
      setup_status: 'pending',
      setup_phase: 'queued',
      standings_ready_at: null,
    });
  });
});
