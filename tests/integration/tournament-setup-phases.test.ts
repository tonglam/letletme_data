import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();

import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import { tournamentSetupLifecycleScope } from '../../src/domain/mutation-scope';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { reserveSchedulerObligation } from '../../src/repositories/scheduler-obligations';
import { getDbClient } from '../../src/db/singleton';
import { withMutationScopes } from '../../src/utils/mutation-scopes';
import { withTournamentSetupPhase } from '../../src/utils/tournament-setup-execution';

const season = explicitSeasonRef('9596');
const tournamentId = 995_501;
const jobName = 'integration-setup-phase-refresh';
const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
async function cleanup() {
  await sql`DELETE FROM ops.scheduler_obligations WHERE job_name=${jobName}`;
  await sql`DELETE FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.entries WHERE season_id=${season.seasonId} AND entry_id=${tournamentId}`;
  await sql`DELETE FROM fpl.seasons WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM ops.mutation_scopes WHERE scope_key=${tournamentSetupLifecycleScope(tournamentId)}`;
}
beforeEach(async () => {
  await cleanup();
  await sql`INSERT INTO fpl.seasons (season_id,season_code,display_name,start_year,end_year,lifecycle_state)
    VALUES (${season.seasonId},${season.seasonCode},'Setup phases fixture',2095,2096,'reference_only')`;
  await sql`INSERT INTO competition.entries (season_id,entry_id,entry_name,player_name)
    VALUES (${season.seasonId},${tournamentId},'Fixture','Fixture')`;
  await sql`INSERT INTO competition.tournaments (season_id,tournament_id,name,creator,admin_entry_id,
    league_id,league_type,total_team_num,tournament_mode,group_mode,group_auto_averages,state,roster_mode,setup_status)
    VALUES (${season.seasonId},${tournamentId},'Fixture','integration-test',${tournamentId},${tournamentId},
    'classic',2,'normal','no_group',false,'active','official_sync','pending')`;
});
afterEach(async () => {
  mock.restore();
  await cleanup();
});
afterAll(() => sql.end());
function claim() {
  return withMutationScopes(
    {
      queueName: 'tournament-setup',
      jobName: 'claim',
      tournamentId,
      scopes: [tournamentSetupLifecycleScope(tournamentId)],
    },
    () =>
      tournamentInfoRepository.markSetupProcessing(
        season,
        tournamentId,
        '2095-01-01 00:00:00+00',
        1,
      ),
  );
}

test('a repeated attempt receives a new execution identity without replacing its resume marker', async () => {
  const first = await claim();
  const second = await claim();
  expect(second.attempt).toBe(first.attempt);
  expect(second.startedAt).not.toBe(first.startedAt);
  let called = false;
  await expect(
    withTournamentSetupPhase(season, tournamentId, first, 'stale', [], async () => {
      called = true;
    }),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_SETUP_EXECUTION_STALE' });
  expect(called).toBe(false);
  const status = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
  expect(status!.setupProgressUpdatedAt).toBe('2095-01-01 00:00:00+00');
  await withTournamentSetupPhase(season, tournamentId, second, 'current', [], async () => {
    called = true;
  });
  expect(called).toBe(true);
});

test('a failed later phase rolls itself back without undoing an earlier committed phase', async () => {
  const execution = await claim();
  await withTournamentSetupPhase(season, tournamentId, execution, 'first', [], async () => {
    const tx = await getDbClient();
    await tx`UPDATE competition.tournaments SET source_league_name='first committed'
      WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  });
  const failure = new Error('owned phase failure');
  await expect(
    withTournamentSetupPhase(season, tournamentId, execution, 'second', [], async () => {
      const tx = await getDbClient();
      await tx`UPDATE competition.tournaments SET source_league_name='must roll back'
      WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
      throw failure;
    }),
  ).rejects.toBe(failure);
  const [saved] = await sql`SELECT source_league_name FROM competition.tournaments
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  expect(saved!.source_league_name).toBe('first committed');
  // A fresh claim can commit between phases; the previous execution then loses ownership.
  await claim();
  await expect(
    withTournamentSetupPhase(season, tournamentId, execution, 'late', [], async () => {}),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_SETUP_EXECUTION_STALE' });
});

test('terminal readiness and its refresh obligation commit or roll back as one phase', async () => {
  const execution = await claim();
  const publish = async () => {
    await tournamentInfoRepository.markSetupResult(season, tournamentId, 'ready');
    await reserveSchedulerObligation({
      definition: {
        name: jobName,
        cadence: 'fixture',
        timezone: 'UTC',
        queueName: 'tournament-sync',
      },
      plan: {
        scopeKey: `fixture:${tournamentId}`,
        periodKey: 'final',
        dueAt: new Date(),
        source: 'reconcile',
      },
    });
  };
  const failure = new Error('owned finalization failure');
  await expect(
    withTournamentSetupPhase(season, tournamentId, execution, 'finalize', [], async () => {
      await publish();
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect((await tournamentInfoRepository.findSetupStatus(season, tournamentId))!.setupStatus).toBe(
    'processing',
  );
  const [before] =
    await sql`SELECT count(*)::int AS count FROM ops.scheduler_obligations WHERE job_name=${jobName}`;
  expect(before!.count).toBe(0);
  await withTournamentSetupPhase(season, tournamentId, execution, 'finalize', [], publish);
  expect((await tournamentInfoRepository.findSetupStatus(season, tournamentId))!.setupStatus).toBe(
    'ready',
  );
  const [after] =
    await sql`SELECT count(*)::int AS count FROM ops.scheduler_obligations WHERE job_name=${jobName}`;
  expect(after!.count).toBe(1);
  await expect(
    withTournamentSetupPhase(season, tournamentId, execution, 'after-ready', [], async () => {}),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_SETUP_EXECUTION_STALE' });
});

test('a committed claim persists its own retry and rejects stale failure and phase writes', async () => {
  const old = await claim();
  const current = await claim();
  const failure = {
    attempt: current.attempt,
    terminal: false,
    errorCode: '57014',
    nextRetryAt: new Date(Date.now() + 60000),
    startedAt: new Date(),
  };
  expect(
    await tournamentInfoRepository.markSetupAttemptFailure(season, tournamentId, {
      ...failure,
      execution: old,
    }),
  ).toBe(false);
  expect(
    await tournamentInfoRepository.markSetupAttemptFailure(season, tournamentId, {
      ...failure,
      execution: current,
    }),
  ).toBe(true);
  const status = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
  expect(status!.setupAttempt).toBe(1);
  expect(status!.setupLastErrorCode).toBe('57014');
  expect(status!.setupNextRetryAt).not.toBeNull();
  expect(
    await tournamentInfoRepository.markSetupAttemptFailure(season, tournamentId, {
      ...failure,
      execution: current,
    }),
  ).toBe(false);
  await expect(
    withTournamentSetupPhase(season, tournamentId, current, 'late', [], async () => {}),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_SETUP_EXECUTION_STALE' });
});

test('setup provider wait releases lifecycle ownership and a superseded service cannot rebuild', async () => {
  const backfill = await import('../../src/services/tournament-backfill.service');
  const { setupTournamentStructure } = await import('../../src/services/tournament-setup.service');
  let entered!: () => void;
  const providerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const providerWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  spyOn(backfill, 'syncTournamentEntryDetails').mockImplementation(async () => {
    entered();
    await providerWait;
    return [];
  });
  const owner = await claim();
  const pending = setupTournamentStructure(season, tournamentId, { execution: owner }).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await providerEntered;
    const replacement = await claim();
    expect(replacement.startedAt).not.toBe(owner.startedAt);
    release();
    expect(await pending).toMatchObject({ code: 'TOURNAMENT_SETUP_EXECUTION_STALE' });
    const status = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
    expect(status!.setupPhase).toBe('syncing_entries');
  } finally {
    release();
    await pending;
  }
}, 5000);

test('setup enrichment publishes only its scoped Trends data without a global MV refresh', async () => {
  const selection = await import('../../src/services/tournament-selection-stats.service');
  const trends = await import('../../src/services/tournament-trends-publication.service');
  const league = await import('../../src/services/league-event-results.service');
  const { enrichTournamentHistory } = await import(
    '../../src/services/tournament-backfill.service'
  );
  const globalRefresh = spyOn(selection, 'syncTournamentSelectionStats').mockRejectedValue(
    new Error('global refresh must be deferred'),
  );
  const publish = spyOn(trends, 'publishTournamentTrendScope').mockResolvedValue({
    tournamentId,
    eventId: 1,
    rows: 0,
    isActive: true,
    transfersState: 'READY',
  } as never);
  spyOn(league, 'syncLeagueEventResultsByTournament').mockResolvedValue({
    failedUnits: 0,
    skipped: 0,
  } as never);
  const execution = await claim();
  const issues = await enrichTournamentHistory(
    season,
    tournamentId,
    [],
    { startEventId: 1, endEventId: 1 },
    {
      setupExecution: execution,
      includeTransferHistory: false,
    },
  );
  expect(issues).toEqual([]);
  expect(globalRefresh).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledWith(season, tournamentId, 1);
});

test('terminal timestamps respect the database execution clock even ahead of the application clock', async () => {
  await claim();
  await sql`UPDATE competition.tournaments SET setup_started_at = clock_timestamp() + interval '1 second'
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await tournamentInfoRepository.markSetupResult(season, tournamentId, 'ready');
  const [result] = await sql`SELECT setup_finished_at >= setup_started_at AS ordered
    FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  expect(result!.ordered).toBe(true);
});
