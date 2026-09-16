import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import { databaseTransactionStorage } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { tournamentOfficialH2HRepository } from '../../src/repositories/tournament-official-h2h';
import { syncOfficialH2HTournament } from '../../src/services/tournament-official-h2h.service';
import { fplClient } from '../../src/clients/fpl';
import { processTournamentSyncJob } from '../../src/workers/tournament-sync.worker';
import * as seasons from '../../src/services/season-scoped-job.service';
const season = explicitSeasonRef('9394');
const id = 995_901;
const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
const contexts: boolean[] = [];
async function cleanup() {
  await sql`DELETE FROM competition.tournament_knockout_results WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.tournament_battle_group_results WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.tournament_knockouts WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.tournament_groups WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.tournament_entries WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.tournaments WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.entry_event_results WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.entries WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM fpl.events WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM fpl.seasons WHERE season_id=${season.seasonId}`;
}
async function standings() {
  contexts.push(Boolean(databaseTransactionStorage.getStore()));
  if (!contexts.at(-1))
    await sql.begin(async (tx) => {
      await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key='tournament-structure:global' FOR UPDATE NOWAIT`;
    });
  return {
    standings: {
      results: [
        {
          entry: id,
          total: 3,
          rank: 1,
          matches_played: 1,
          matches_won: 1,
          matches_drawn: 0,
          matches_lost: 0,
          points_for: 20,
        },
      ],
      has_next: false,
    },
  } as never;
}
beforeEach(async () => {
  await cleanup();
  contexts.length = 0;
  await sql`INSERT INTO fpl.seasons (season_id,season_code,display_name,start_year,end_year,lifecycle_state) VALUES (${season.seasonId},${season.seasonCode},'H2H transaction fixture',2093,2094,'reference_only')`;
  await sql`INSERT INTO fpl.events (season_id,event_id,name) VALUES (${season.seasonId},1,'Fixture')`;
  await sql`INSERT INTO competition.entries (season_id,entry_id,entry_name,player_name) VALUES (${season.seasonId},${id},'Fixture','Fixture')`;
  await sql`INSERT INTO competition.tournaments (season_id,tournament_id,name,creator,admin_entry_id,league_id,league_type,total_team_num,tournament_mode,group_mode,group_auto_averages,state,roster_mode,setup_status,group_started_event_id,group_ended_event_id)
    VALUES (${season.seasonId},${id},'Fixture','integration',${id},${id},'h2h',1,'normal','battle_races',false,'active','official_sync','ready',1,1)`;
  await sql`UPDATE competition.tournaments SET standings_ready_at=clock_timestamp() WHERE season_id=${season.seasonId}`;
  await sql`INSERT INTO competition.tournament_entries (season_id,tournament_id,league_id,entry_id) VALUES (${season.seasonId},${id},${id},${id})`;
  await sql`INSERT INTO competition.tournament_groups (season_id,tournament_id,entry_id,group_id,group_name,group_index) VALUES (${season.seasonId},${id},${id},1,'Fixture',1)`;
  await sql`INSERT INTO competition.entry_event_results (season_id,entry_id,event_id,event_points,event_net_points) VALUES (${season.seasonId},${id},1,20,20)`;
  await sql`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES ('tournament-structure:global',now()) ON CONFLICT DO NOTHING`;
  spyOn(fplClient, 'getLeagueH2HStandings').mockImplementation(standings);
  spyOn(fplClient, 'getLeagueH2HMatches').mockResolvedValue({
    results: [],
    has_next: false,
  } as never);
  spyOn(seasons, 'requireCurrentSeasonForJob').mockResolvedValue(season);
});
afterEach(async () => {
  mock.restore();
  await cleanup();
});
afterAll(() => sql.end());
async function run(name = 'tournament-official-h2h') {
  return processTournamentSyncJob({
    id: 'h2h-transaction-fixture',
    name,
    queueName: 'tournament-sync',
    attemptsMade: 0,
    opts: {},
    data: { ...season, eventId: 1, source: 'manual' },
  } as never);
}
test('H2H worker fetches without a transaction and commits a complete group publication', async () => {
  await run();
  expect(contexts).toEqual([false]);
  const [row] =
    await sql`SELECT official_schedule_synced_at FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
  expect(row!.official_schedule_synced_at).not.toBeNull();
});

test('full H2H reconciliation atomically replaces stale rows and bracket topology', async () => {
  await sql`INSERT INTO competition.tournament_battle_group_results(
      source_result_id,tournament_id,season_id,group_id,event_id,home_index,home_entry_id,
      away_index,away_entry_id,official_match_id,source_order,is_bye)
    VALUES
      (995901,${id},${season.seasonId},1,1,1,${id},2,NULL,995901,0,true),
      (995902,${id},${season.seasonId},1,1,3,${id},4,NULL,995902,1,true)`;
  await sql`INSERT INTO competition.tournament_knockout_results(
      source_result_id,tournament_id,season_id,event_id,match_id,play_against_id,
      home_entry_id,away_entry_id,match_winner,official_match_id,source_order)
    VALUES
      (995901,${id},${season.seasonId},1,1,1,${id},NULL,${id},995903,2),
      (995902,${id},${season.seasonId},1,2,1,${id},NULL,${id},995904,3)`;
  await sql`INSERT INTO competition.tournament_knockouts(
      source_knockout_id,tournament_id,season_id,round,started_event_id,ended_event_id,
      match_id,next_match_id,home_entry_id,round_winner)
    VALUES
      (995901,${id},${season.seasonId},1,1,1,1,NULL,${id},${id}),
      (995902,${id},${season.seasonId},9,1,1,2,99,${id},${id})`;

  await tournamentOfficialH2HRepository.publish(season, id, {
    checkedAt: new Date('2026-09-16T07:00:00.000Z'),
    scheduleHash: 'full-reconcile-test',
    lockSchedule: false,
    fullReconcile: true,
    battleRows: [
      {
        tournamentId: id,
        groupId: 1,
        eventId: 1,
        homeIndex: 1,
        homeEntryId: id,
        homeNetPoints: 20,
        homeRank: null,
        homeMatchPoints: 3,
        awayIndex: 2,
        awayEntryId: null,
        awayNetPoints: null,
        awayRank: null,
        awayMatchPoints: 0,
        officialMatchId: 996001,
        sourceOrder: 0,
        homeIsAverage: false,
        awayIsAverage: true,
        isBye: true,
        sourceCheckedAt: new Date('2026-09-16T07:00:00.000Z'),
      },
    ],
    knockoutRows: [
      {
        tournamentId: id,
        eventId: 1,
        matchId: 1,
        playAgainstId: 1,
        homeEntryId: id,
        homeNetPoints: 20,
        awayEntryId: null,
        awayNetPoints: null,
        matchWinner: id,
        officialMatchId: 996002,
        sourceOrder: 1,
        knockoutName: 'Final',
        tiebreak: null,
        sourceCheckedAt: new Date('2026-09-16T07:00:00.000Z'),
      },
    ],
    bracketRows: [
      {
        tournamentId: id,
        round: 1,
        startedEventId: 1,
        endedEventId: 1,
        matchId: 1,
        nextMatchId: null,
        homeEntryId: id,
        awayEntryId: null,
        roundWinner: id,
      },
    ],
    groupRows: [],
  });

  const battleRows = await sql`
    SELECT official_match_id FROM competition.tournament_battle_group_results
    WHERE season_id=${season.seasonId} AND tournament_id=${id}
    ORDER BY official_match_id`;
  const knockoutRows = await sql`
    SELECT official_match_id FROM competition.tournament_knockout_results
    WHERE season_id=${season.seasonId} AND tournament_id=${id}
    ORDER BY official_match_id`;
  const brackets = await sql`
    SELECT match_id, round, next_match_id
    FROM competition.tournament_knockouts
    WHERE season_id=${season.seasonId} AND tournament_id=${id}
    ORDER BY match_id`;
  expect(battleRows.map((row) => row.official_match_id)).toEqual([996001]);
  expect(knockoutRows.map((row) => row.official_match_id)).toEqual([996002]);
  expect(Array.from(brackets)).toEqual([{ match_id: 1, round: 1, next_match_id: null }]);
});
test('changed tournament configuration during fetch rejects the entire old publication', async () => {
  spyOn(fplClient, 'getLeagueH2HStandings').mockImplementation(async () => {
    const response = await standings();
    await sql`UPDATE competition.tournaments SET league_id=league_id+1,updated_at=clock_timestamp() WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
    return response;
  });
  const config = (await tournamentInfoRepository.findSetupConfig(season, id))!;
  await expect(syncOfficialH2HTournament(season, config)).rejects.toMatchObject({
    code: 'TOURNAMENT_OFFICIAL_H2H_SOURCE_STALE',
  });
  const [row] =
    await sql`SELECT official_schedule_synced_at FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
  expect(row!.official_schedule_synced_at).toBeNull();
});
test('a concurrent publication invalidates a previously captured revision', async () => {
  const config = (await tournamentInfoRepository.findSetupConfig(season, id))!;
  const old = await tournamentOfficialH2HRepository.captureRevision(season, config);
  await syncOfficialH2HTournament(season, config);
  await expect(
    tournamentOfficialH2HRepository.publish(season, id, {
      expectedRevision: old,
      checkedAt: new Date(),
      scheduleHash: 'stale',
      lockSchedule: false,
      battleRows: [],
      knockoutRows: [],
      bracketRows: [],
      groupRows: [],
    }),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_OFFICIAL_H2H_SOURCE_STALE' });
});

test('a same-timestamp row update still invalidates the pre-fetch revision', async () => {
  const config = (await tournamentInfoRepository.findSetupConfig(season, id))!;
  const old = await tournamentOfficialH2HRepository.captureRevision(season, config);
  await sql`UPDATE competition.tournaments SET source_league_name='new metadata' WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
  await expect(
    tournamentOfficialH2HRepository.publish(season, id, {
      expectedRevision: old,
      checkedAt: new Date(),
      scheduleHash: 'stale',
      lockSchedule: false,
      battleRows: [],
      knockoutRows: [],
      bracketRows: [],
      groupRows: [],
    }),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_OFFICIAL_H2H_SOURCE_STALE' });
});

test('a changed roster rejects the response even before a roster marker is refreshed', async () => {
  const config = (await tournamentInfoRepository.findSetupConfig(season, id))!;
  spyOn(fplClient, 'getLeagueH2HStandings').mockImplementation(async () => {
    const response = await standings();
    await sql`DELETE FROM competition.tournament_entries WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
    return response;
  });
  await expect(syncOfficialH2HTournament(season, config)).rejects.toMatchObject({
    code: 'TOURNAMENT_OFFICIAL_H2H_SOURCE_STALE',
  });
  const [row] =
    await sql`SELECT official_schedule_synced_at FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
  expect(row!.official_schedule_synced_at).toBeNull();
});

test('battle-race cascade also releases the outer transaction for official H2H', async () => {
  await run('tournament-battle-race');
  expect(contexts).toEqual([false]);
});

test('local battle-race strategy retains its database-only mutation scope', async () => {
  const battle = await import('../../src/services/tournament-battle-race-results.service');
  const config = (await tournamentInfoRepository.findSetupConfig(season, id))!;
  spyOn(tournamentInfoRepository, 'findBattleRaceByEvent').mockResolvedValue([
    { ...config, leagueType: 'classic', rosterMode: 'snapshot' },
  ] as never);
  const local = spyOn(battle.LocalBattleStrategy, 'sync').mockImplementation(async () => {
    expect(databaseTransactionStorage.getStore()).toBeDefined();
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key='tournament-structure:global' FOR UPDATE NOWAIT`;
      }),
    ).rejects.toMatchObject({ code: '55P03' });
    return { updatedGroups: 1, updatedResults: 0, skipped: 0 };
  });
  await battle.syncTournamentBattleRaceResults(season, 1);
  expect(local).toHaveBeenCalledTimes(1);
});
