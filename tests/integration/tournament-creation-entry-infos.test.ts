import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, describe, expect, test } from 'bun:test';

import { planTournamentStructure, type TournamentParticipant } from '../../src/domain/tournament';
import { getDbClient } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';

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
});
