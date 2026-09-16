import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();

import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from 'postgres';
import { createEventRepository } from '../../src/repositories/events';
import { leagueEventResultsRepository } from '../../src/repositories/league-event-results';
import { getDb } from '../../src/db/singleton';
import { pruneTournamentDerivedResultsOutsideStructure } from '../../src/services/tournament-structure.service';

const season = { seasonId: 2097, seasonCode: '9798' };
const ids = [997_471, 997_472, 997_473, 997_474];
const cutoff = '2026-09-01T10:00:00.123456Z';
const officialTournamentId = 997_471;
const observer = postgres(process.env.DATABASE_URL!, { max: 1 });

beforeAll(async () => {
  await observer`INSERT INTO fpl.seasons(season_id,season_code,display_name,start_year,end_year,lifecycle_state)
    VALUES (${season.seasonId},${season.seasonCode},'Repair fence test',2097,2098,'active')`;
  await observer`INSERT INTO fpl.events(season_id,event_id,name,finished,data_checked,data_checked_at)
    VALUES (${season.seasonId},1,'Repair fence event',true,true,${cutoff}::text::timestamptz)`;
  await observer`INSERT INTO competition.entries(season_id,entry_id,entry_name,player_name)
    SELECT ${season.seasonId},id,'Repair entry','Test' FROM unnest(${ids}::integer[]) ids(id)`;
  await observer`INSERT INTO competition.tournaments(
      tournament_id,season_id,name,creator,admin_entry_id,league_id,league_type,total_team_num,
      tournament_mode,group_mode,group_auto_averages,knockout_mode,state,setup_status,setup_phase)
    VALUES (
      ${officialTournamentId},${season.seasonId},'Official repair fence','test',${ids[0]},997471,'h2h',4,
      'normal','battle_races',false,'head_to_head','active','ready','ready')`;
  await observer`INSERT INTO competition.tournament_battle_group_results(
      source_result_id,tournament_id,season_id,group_id,event_id,home_index,home_entry_id,
      away_index,away_entry_id,official_match_id,source_order,source_checked_at)
    VALUES
      (997471,${officialTournamentId},${season.seasonId},900,1,0,${ids[0]},1,${ids[1]},7001,0,${cutoff}::text::timestamptz),
      (997472,${officialTournamentId},${season.seasonId},901,1,0,${ids[0]},1,${ids[1]},NULL,NULL,${cutoff}::text::timestamptz)`;
  await observer`INSERT INTO competition.tournament_knockout_results(
      source_result_id,tournament_id,season_id,event_id,match_id,play_against_id,home_entry_id,
      away_entry_id,official_match_id,source_order,source_checked_at)
    VALUES
      (997471,${officialTournamentId},${season.seasonId},1,600,1,${ids[0]},${ids[1]},8001,0,${cutoff}::text::timestamptz),
      (997472,${officialTournamentId},${season.seasonId},1,601,1,${ids[0]},${ids[1]},NULL,NULL,${cutoff}::text::timestamptz)`;
  await observer`INSERT INTO competition.league_event_results(
    season_id,league_id,league_type,entry_id,event_id,source_checked_at,source_live_checked_at,source_picks_checked_at)
    SELECT ${season.seasonId},997471,'classic',id,1,${cutoff}::text::timestamptz,
      CASE WHEN id=${ids[0]} THEN NULL WHEN id=${ids[1]} THEN '2026-08-31'::timestamptz ELSE ${cutoff}::text::timestamptz END,
      CASE WHEN id=${ids[0]} THEN NULL WHEN id=${ids[2]} THEN '2026-08-31'::timestamptz ELSE ${cutoff}::text::timestamptz END
    FROM unnest(${ids}::integer[]) ids(id)`;
});
afterAll(async () => {
  await observer`DELETE FROM competition.tournament_battle_group_results WHERE tournament_id=${officialTournamentId}`;
  await observer`DELETE FROM competition.tournament_knockout_results WHERE tournament_id=${officialTournamentId}`;
  await observer`DELETE FROM competition.tournaments WHERE tournament_id=${officialTournamentId} AND season_id=${season.seasonId}`;
  await observer`DELETE FROM competition.league_event_results WHERE season_id=${season.seasonId}`;
  await observer`DELETE FROM competition.entries WHERE season_id=${season.seasonId}`;
  await observer`DELETE FROM fpl.events WHERE season_id=${season.seasonId}`;
  await observer`DELETE FROM ops.sync_runs WHERE season_id=${season.seasonId} AND mode='batch-cost'`;
  await observer`DELETE FROM fpl.seasons WHERE season_id=${season.seasonId}`;
  await observer.end();
});

test('FINAL reuse rejects legacy missing source checkpoints and either stale source', async () => {
  expect(
    await leagueEventResultsRepository.findEntryIdsByLeagueEvent(
      season,
      997471,
      'classic',
      1,
      ids,
      cutoff,
    ),
  ).toEqual([ids[3]]);
});

test('the exact FINAL boundary cannot change until the standings transaction finishes', async () => {
  await (
    await getDb()
  ).transaction(async (tx) => {
    expect(
      await createEventRepository(tx).findDataCheckedAtExact(season, 1, { lock: 'share' }),
    ).toBe(cutoff);
    await expect(
      observer.begin(async (writer) => {
        await writer`SET LOCAL lock_timeout='100ms'`;
        await writer`UPDATE fpl.events SET data_checked_at=clock_timestamp() WHERE season_id=${season.seasonId} AND event_id=1`;
      }),
    ).rejects.toMatchObject({ code: '55P03' });
  });
  // Release is real: a correction can proceed after the protected commit.
  await observer`UPDATE fpl.events SET data_checked_at=clock_timestamp() WHERE season_id=${season.seasonId} AND event_id=1`;
});

test('corrected FINAL derivation advances its ordering without demanding newer provider evidence', async () => {
  const source = new Date(cutoff);
  const attempt = new Date('2026-09-16T06:00:00.000Z');
  await observer`UPDATE fpl.events SET data_checked_at=${cutoff}::text::timestamptz WHERE season_id=${season.seasonId} AND event_id=1`;
  // Legacy repair stamped a later attempt time into both source fields.
  await observer`UPDATE competition.league_event_results
    SET source_live_checked_at='2026-09-15'::timestamptz, source_picks_checked_at='2026-09-15'::timestamptz
    WHERE season_id=${season.seasonId} AND entry_id=${ids[3]}`;
  expect(
    await leagueEventResultsRepository.findEntryIdsByLeagueEvent(
      season,
      997471,
      'classic',
      1,
      [ids[3]],
      cutoff,
      attempt,
    ),
  ).toEqual([]);
  const row = {
    leagueId: 997471,
    leagueType: 'classic' as const,
    eventId: 1,
    entryId: ids[3],
    entryName: 'Corrected',
    sourceCheckedAt: attempt,
    sourceLiveCheckedAt: source,
    sourcePicksCheckedAt: source,
  };
  await leagueEventResultsRepository.upsertBatch(season, [row], { eventId: 1, cutoff });
  expect(
    await leagueEventResultsRepository.findEntryIdsByLeagueEvent(
      season,
      997471,
      'classic',
      1,
      [ids[3]],
      cutoff,
      attempt,
    ),
  ).toEqual([ids[3]]);
  await leagueEventResultsRepository.upsertBatch(
    season,
    [{ ...row, entryName: 'Late stale attempt', sourceCheckedAt: source }],
    { eventId: 1, cutoff },
  );
  const [stored] =
    await observer`SELECT entry_name FROM competition.league_event_results WHERE season_id=${season.seasonId} AND entry_id=${ids[3]}`;
  expect(stored?.entry_name).toBe('Corrected');
  await observer`UPDATE fpl.events SET data_checked_at=clock_timestamp() WHERE season_id=${season.seasonId} AND event_id=1`;
  await expect(
    leagueEventResultsRepository.upsertBatch(
      season,
      [{ ...row, entryName: 'Stale FINAL', sourceCheckedAt: new Date(attempt.getTime() + 1000) }],
      { eventId: 1, cutoff },
    ),
  ).rejects.toThrow('Failed to upsert league event results');
  const [after] =
    await observer`SELECT entry_name FROM competition.league_event_results WHERE season_id=${season.seasonId} AND entry_id=${ids[3]}`;
  expect(after?.entry_name).toBe('Corrected');
});

test('structure repair pruning preserves official H2H rows while removing local stale rows', async () => {
  await pruneTournamentDerivedResultsOutsideStructure(season, officialTournamentId);
  const battleRows = await observer`
    SELECT official_match_id FROM competition.tournament_battle_group_results
    WHERE tournament_id=${officialTournamentId} ORDER BY source_result_id`;
  const knockoutRows = await observer`
    SELECT official_match_id FROM competition.tournament_knockout_results
    WHERE tournament_id=${officialTournamentId} ORDER BY source_result_id`;
  expect(battleRows.map((row) => row.official_match_id)).toEqual([7001]);
  expect(knockoutRows.map((row) => row.official_match_id)).toEqual([8001]);
});
