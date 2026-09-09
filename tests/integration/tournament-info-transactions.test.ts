import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();

import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { fplClient } from '../../src/clients/fpl';
import * as singleton from '../../src/db/singleton';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentInfo } from '../../src/services/tournament-info.service';
import * as seasons from '../../src/services/season-scoped-job.service';
import * as fences from '../../src/utils/scheduler-obligation-fence';
import * as attempts from '../../src/utils/data-sync-attempt';
import * as tracking from '../../src/utils/job-run-logger';
import { processTournamentSyncJob } from '../../src/workers/tournament-sync.worker';

const season = explicitSeasonRef('9596');
const id = 995_701;
const scope = 'tournament-info:all';
const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
async function cleanup() {
  await observer`DELETE FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id IN (${id},${id + 1})`;
  await observer`DELETE FROM competition.entries WHERE season_id=${season.seasonId} AND entry_id=${id}`;
  await observer`DELETE FROM fpl.seasons WHERE season_id=${season.seasonId}`;
}
beforeEach(async () => {
  await cleanup();
  await observer`INSERT INTO fpl.seasons(season_id,season_code,display_name,start_year,end_year,lifecycle_state)
    VALUES(${season.seasonId},${season.seasonCode},'Name sync fixture',2095,2096,'reference_only')`;
  await observer`INSERT INTO competition.entries(season_id,entry_id,entry_name,player_name)
    VALUES(${season.seasonId},${id},'Fixture','Fixture')`;
  await observer`INSERT INTO competition.tournaments(season_id,tournament_id,name,creator,admin_entry_id,
    league_id,league_type,total_team_num,tournament_mode,group_mode,group_auto_averages,state,source_league_name)
    VALUES(${season.seasonId},${id},'Fixture','integration-test',${id},101,'classic',2,'normal','no_group',false,'active','Previous')`;
  await observer`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES(${scope},now()) ON CONFLICT DO NOTHING`;
});
afterEach(async () => {
  mock.restore();
  await cleanup();
});
afterAll(() => observer.end());
async function observeLock() {
  await observer.begin(async (tx) => {
    await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${scope} FOR UPDATE NOWAIT`;
  });
}
async function savedName() {
  const [row] =
    await observer`SELECT source_league_name FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
  return row!.source_league_name;
}

test('worker fetches without a transaction, then protects and commits the correctly mapped name', async () => {
  spyOn(seasons, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  spyOn(fences, 'startCurrentSchedulerJob').mockResolvedValue(true);
  spyOn(attempts, 'runDataSyncAttempt').mockImplementation(async (_input, operation) =>
    operation(),
  );
  spyOn(tracking, 'runTrackedJob').mockImplementation(async (_input, operation) => operation());
  spyOn(tracking, 'logJobTriggered').mockImplementation(() => undefined);
  let providerCalled = false;
  let providerHadTransaction = false;
  spyOn(fplClient, 'getLeagueClassicStandings').mockImplementation(async () => {
    providerHadTransaction = Boolean(singleton.databaseTransactionStorage.getStore());
    if (!providerHadTransaction) await observeLock();
    providerCalled = true;
    return { league: { name: 'New League' } } as never;
  });
  const original = singleton.getDb;
  let lockedWrites = 0;
  spyOn(singleton, 'getDb').mockImplementation(async () => {
    if (singleton.databaseTransactionStorage.getStore()) {
      await expect(observeLock()).rejects.toMatchObject({ code: '55P03' });
      lockedWrites++;
    }
    return original();
  });
  await processTournamentSyncJob({
    id: 'name-fixture',
    name: 'tournament-info',
    queueName: 'tournament-sync',
    attemptsMade: 0,
    data: { ...season, eventId: 1, source: 'manual' },
  } as never);
  expect(providerCalled).toBe(true);
  expect(providerHadTransaction).toBe(false);
  expect(lockedWrites).toBeGreaterThan(0);
  expect(await savedName()).toBe('New League');
  await observeLock();
});

test('a tournament rebound to a different league while fetching rejects the old response', async () => {
  spyOn(fplClient, 'getLeagueClassicStandings').mockImplementation(async () => {
    await observer`UPDATE competition.tournaments SET league_id=102,source_league_name='Rebound',updated_at=clock_timestamp() WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
    return { league: { name: 'Old League Response' } } as never;
  });
  expect(await syncTournamentInfo(season)).toMatchObject({ updated: 0 });
  expect(await savedName()).toBe('Rebound');
});

test('a response captured before a newer name write cannot replace that write', async () => {
  const [snapshot] = await tournamentInfoRepository.findAllNames(season);
  await observer`UPDATE competition.tournaments SET source_league_name='Newer',updated_at=clock_timestamp() WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
  expect(
    await tournamentInfoRepository.updateSourceLeagueNames(season, [
      {
        id,
        sourceLeagueName: 'Stale',
        leagueId: snapshot!.leagueId,
        leagueType: snapshot!.leagueType,
        expectedUpdatedAt: snapshot!.updatedAt,
      },
    ]),
  ).toBe(0);
  expect(await savedName()).toBe('Newer');
});

test('one failed league fetch preserves the previous accepted names for the batch', async () => {
  await observer`INSERT INTO competition.tournaments(season_id,tournament_id,name,creator,admin_entry_id,
    league_id,league_type,total_team_num,tournament_mode,group_mode,group_auto_averages,state,source_league_name)
    VALUES(${season.seasonId},${id + 1},'Other','integration-test',${id},103,'classic',2,'normal','no_group',false,'active','Other Previous')`;
  spyOn(fplClient, 'getLeagueClassicStandings').mockImplementation(async (leagueId) => {
    if (leagueId === 103) throw new Error('provider unavailable');
    return { league: { name: 'Partial Result' } } as never;
  });
  await expect(syncTournamentInfo(season)).rejects.toThrow('did not converge');
  expect(await savedName()).toBe('Previous');
});
