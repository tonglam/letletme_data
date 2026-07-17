import { afterAll, describe, expect, test } from 'bun:test';

import { planTournamentStructure, type TournamentParticipant } from '../../src/domain/tournament';
import { getDbClient } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentBattleRaceResults } from '../../src/services/tournament-battle-race-results.service';

/**
 * FP-09 (C6): battle-race must not award wins against phantom zeros.
 * A matchup where either side lacks an entry_event_results row is skipped
 * (NULL match points preserved), group counters are recomputed from the full
 * matchup history, and `played` is derived absolutely — so backfilling the
 * missing result and re-running converges to the correct counters.
 */

const ENTRY_BASE = 99000301;
const ENTRY_A = ENTRY_BASE; // beats B
const ENTRY_B = ENTRY_BASE + 1; // loses to A
const ENTRY_C = ENTRY_BASE + 2; // beats D, but only after D is backfilled
const ENTRY_D = ENTRY_BASE + 3; // result missing in run 1, backfilled in run 2
const GROUP_ID = 1;

// Deterministic net points per entry
const NET = { [ENTRY_A]: 50, [ENTRY_B]: 40, [ENTRY_C]: 60, [ENTRY_D]: 55 } as const;
const OVERALL_RANK = { [ENTRY_A]: 1000, [ENTRY_B]: 2000, [ENTRY_C]: 500, [ENTRY_D]: 800 } as const;

const client = await getDbClient();
const eventRows = await client<{ id: number }[]>`SELECT id FROM events ORDER BY id DESC LIMIT 1`;
const testEventId = eventRows[0]?.id ?? null;

let tournamentId: number | null = null;

type BattleRow = {
  home_entry_id: number;
  away_entry_id: number;
  home_net_points: number | null;
  home_match_points: number | null;
  away_net_points: number | null;
  away_match_points: number | null;
};

type GroupRow = {
  entry_id: number;
  group_points: number | null;
  group_rank: number | null;
  played: number | null;
  won: number | null;
  drawn: number | null;
  lost: number | null;
};

async function fetchBattleRows(): Promise<BattleRow[]> {
  return client<BattleRow[]>`
    SELECT home_entry_id, away_entry_id, home_net_points, home_match_points,
           away_net_points, away_match_points
    FROM tournament_battle_group_results
    WHERE tournament_id = ${tournamentId}
    ORDER BY home_index
  `;
}

async function fetchGroupRows(): Promise<Map<number, GroupRow>> {
  const rows = await client<GroupRow[]>`
    SELECT entry_id, group_points, group_rank, played, won, drawn, lost
    FROM tournament_groups
    WHERE tournament_id = ${tournamentId}
  `;
  return new Map(rows.map((row) => [row.entry_id, row]));
}

async function insertEntryResult(entryId: number, eventId: number): Promise<void> {
  const net = NET[entryId as keyof typeof NET];
  await client`
    INSERT INTO entry_event_results (
      entry_id, event_id, event_points, event_transfers, event_transfers_cost,
      event_net_points, event_rank, overall_points, overall_rank
    ) VALUES (
      ${entryId}, ${eventId}, ${net}, 0, 0,
      ${net}, ${OVERALL_RANK[entryId as keyof typeof OVERALL_RANK]},
      ${net * 10}, ${OVERALL_RANK[entryId as keyof typeof OVERALL_RANK]}
    )
    ON CONFLICT (entry_id, event_id) DO NOTHING
  `;
}

async function seedTournament(eventId: number): Promise<number> {
  await client`
    INSERT INTO entry_infos ${client(
      [ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D].map((id, index) => ({
        id,
        entry_name: `FP-09 Team ${index + 1}`,
        player_name: `FP-09 Manager ${index + 1}`,
        overall_rank: OVERALL_RANK[id as keyof typeof OVERALL_RANK],
        overall_points: 0,
      })),
    )}
    ON CONFLICT (id) DO NOTHING
  `;

  const participants: TournamentParticipant[] = [ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D].map(
    (id, index) => ({
      id: String(id),
      team: `FP-09 Team ${index + 1}`,
      manager: `FP-09 Manager ${index + 1}`,
      overallRank: index + 1,
      totalPoints: 0,
    }),
  );
  const plan = planTournamentStructure(
    {
      tournamentName: `FP-09 Battle Race ${Date.now()}`,
      adminId: String(ENTRY_A),
      creator: 'fp-09-test',
      participantSource: 'custom',
      leagueUrl: 'https://fantasy.premierleague.com/leagues/900003/standings/c',
      groupFormat: 'points',
      startGameweek: 'GW1',
      endGameweek: 'GW38',
      groupNum: '1',
      qualifiersPerGroup: '2',
      knockoutFormat: 'none',
      selectedParticipantIds: participants.map((p) => p.id),
    },
    participants,
    900003,
    'classic',
  );
  plan.groupMode = 'battle_races';
  const created = await tournamentInfoRepository.createTournamentWithEntries(plan);

  // Force a deterministic single-event group window
  await client`
    UPDATE tournament_infos
    SET group_started_event_id = ${eventId}, group_ended_event_id = ${eventId}
    WHERE id = ${created.id}
  `;

  await client`
    INSERT INTO tournament_groups ${client(
      [ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D].map((entryId, index) => ({
        tournament_id: created.id,
        group_id: GROUP_ID,
        group_name: 'Group A',
        group_index: index + 1,
        entry_id: entryId,
        started_event_id: eventId,
        ended_event_id: eventId,
      })),
    )}
  `;

  // Fixtures: A vs B (both results present), C vs D (D missing until backfill)
  await client`
    INSERT INTO tournament_battle_group_results (
      tournament_id, group_id, event_id,
      home_index, home_entry_id, away_index, away_entry_id
    ) VALUES
      (${created.id}, ${GROUP_ID}, ${eventId}, 1, ${ENTRY_A}, 2, ${ENTRY_B}),
      (${created.id}, ${GROUP_ID}, ${eventId}, 3, ${ENTRY_C}, 4, ${ENTRY_D})
  `;

  return created.id;
}

afterAll(async () => {
  await client.begin(async (tx) => {
    if (tournamentId !== null) {
      await tx`DELETE FROM tournament_battle_group_results WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_groups WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_entries WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_infos WHERE id = ${tournamentId}`;
    }
    await tx`DELETE FROM entry_event_results WHERE entry_id >= ${ENTRY_BASE} AND entry_id < ${ENTRY_BASE + 100}`;
    await tx`DELETE FROM entry_infos WHERE id >= ${ENTRY_BASE} AND id < ${ENTRY_BASE + 100}`;
  });
});

describe.skipIf(testEventId === null)('Battle-race phantom-zero guard (FP-09)', () => {
  test(
    'missing entry result → no match points awarded; backfill + re-run converges',
    async () => {
      const eventId = testEventId!;
      tournamentId = await seedTournament(eventId);

      // Given: entry results for A, B, C — D is missing
      await insertEntryResult(ENTRY_A, eventId);
      await insertEntryResult(ENTRY_B, eventId);
      await insertEntryResult(ENTRY_C, eventId);

      // When: the battle-race sync runs
      const firstRun = await syncTournamentBattleRaceResults(eventId);

      // Then: the A-B matchup is scored from real nets (50 vs 40 → 3/0)
      const battleRows = await fetchBattleRows();
      expect(battleRows).toHaveLength(2);
      expect(battleRows[0]).toMatchObject({
        home_entry_id: ENTRY_A,
        away_entry_id: ENTRY_B,
        home_net_points: 50,
        home_match_points: 3,
        away_net_points: 40,
        away_match_points: 0,
      });

      // And: the C-D matchup is skipped — NULLs preserved, no phantom-zero win
      expect(battleRows[1]).toMatchObject({
        home_entry_id: ENTRY_C,
        away_entry_id: ENTRY_D,
        home_net_points: null,
        home_match_points: null,
        away_net_points: null,
        away_match_points: null,
      });
      expect(firstRun.skipped).toBeGreaterThanOrEqual(1);

      // And: group counters reflect only the scored matchup — C gets NO win
      const groupsAfterFirst = await fetchGroupRows();
      expect(groupsAfterFirst.get(ENTRY_A)).toMatchObject({
        group_points: 3,
        won: 1,
        drawn: 0,
        lost: 0,
        played: 1,
      });
      expect(groupsAfterFirst.get(ENTRY_B)).toMatchObject({
        group_points: 0,
        won: 0,
        drawn: 0,
        lost: 1,
        played: 1,
      });
      expect(groupsAfterFirst.get(ENTRY_C)).toMatchObject({
        group_points: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        played: 1,
      });
      // D has no event result → its group row is untouched
      expect(groupsAfterFirst.get(ENTRY_D)?.played ?? null).toBeNull();

      // When: D's result is backfilled and the sync re-runs for the same event
      await insertEntryResult(ENTRY_D, eventId);
      const secondRun = await syncTournamentBattleRaceResults(eventId);

      // Then: the C-D matchup is now scored from real nets (60 vs 55 → 3/0)
      const battleRowsAfter = await fetchBattleRows();
      expect(battleRowsAfter[1]).toMatchObject({
        home_entry_id: ENTRY_C,
        away_entry_id: ENTRY_D,
        home_net_points: 60,
        home_match_points: 3,
        away_net_points: 55,
        away_match_points: 0,
      });
      expect(secondRun.skipped).toBe(0);

      // And: counters converge — A is NOT double-counted on the re-run
      const groupsAfterSecond = await fetchGroupRows();
      expect(groupsAfterSecond.get(ENTRY_A)).toMatchObject({
        group_points: 3,
        won: 1,
        drawn: 0,
        lost: 0,
        played: 1,
      });
      expect(groupsAfterSecond.get(ENTRY_C)).toMatchObject({
        group_points: 3,
        won: 1,
        drawn: 0,
        lost: 0,
        played: 1,
      });
      expect(groupsAfterSecond.get(ENTRY_D)).toMatchObject({
        group_points: 0,
        won: 0,
        drawn: 0,
        lost: 1,
        played: 1,
      });

      // And: ranks break the 3-3 tie by overall rank (C 500 ahead of A 1000)
      expect(groupsAfterSecond.get(ENTRY_C)?.group_rank).toBe(1);
      expect(groupsAfterSecond.get(ENTRY_A)?.group_rank).toBe(2);
    },
    { timeout: 60_000 },
  );
});
