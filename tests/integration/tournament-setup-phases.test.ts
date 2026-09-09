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
  await sql`DELETE FROM competition.tournament_groups WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.entry_event_results WHERE season_id=${season.seasonId} AND entry_id=${tournamentId}`;
  await sql`DELETE FROM ops.scheduler_obligations WHERE job_name='tournament-materialized-views-refresh' AND scope_key=${`${season.seasonCode}:tournament:${tournamentId}`}`;
  await sql`DELETE FROM competition.tournament_setup_issues WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM ops.scheduler_obligations WHERE job_name=${jobName}`;
  await sql`DELETE FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.entries WHERE season_id=${season.seasonId} AND entry_id IN (${tournamentId}, ${tournamentId + 1})`;
  await sql`DELETE FROM fpl.events WHERE season_id=${season.seasonId}`;
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

test('setup accepts a reused READY Trends publication without a global MV refresh', async () => {
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
    state: 'REUSED',
    publicationState: 'READY',
    ownershipState: 'READY',
    isActive: true,
    transfersState: 'READY',
  } as never);
  spyOn(league, 'syncLeagueEventResultsByTournament').mockResolvedValue({
    failedUnits: 0,
    skipped: 0,
  } as never);
  const events = await import('../../src/services/tournament-event-results.service');
  spyOn(events, 'syncTournamentEventResultsForEntryIds').mockResolvedValue({} as never);
  const execution = await claim();
  const issues = await enrichTournamentHistory(
    season,
    tournamentId,
    [tournamentId],
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

test('the worker settles obsolete delivery and releases its lock before slow Redis progress', async () => {
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const setup = await import('../../src/services/tournament-setup.service');
  const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  spyOn(setup, 'setupTournamentStructure').mockRejectedValue(
    Object.assign(new Error('superseded'), { code: 'TOURNAMENT_SETUP_EXECUTION_STALE' }),
  );
  const failure = spyOn(tournamentInfoRepository, 'markSetupAttemptFailure');
  let settling!: () => void;
  const reachedSettling = new Promise<void>((resolve) => {
    settling = resolve;
  });
  let release!: () => void;
  const redisWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job = {
    id: 'integration-setup-superseded',
    name: 'tournament-setup',
    queueName: 'tournament-setup',
    data: { ...season, tournamentId, source: 'manual', triggeredAt: new Date().toISOString() },
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: async (value: string) => {
      if (value === 'settling') {
        settling();
        await redisWait;
      }
    },
  };
  const pending = processTournamentSetupJob(job as never);
  try {
    await reachedSettling;
    const successor = await claim();
    expect(successor).toBeDefined();
    expect(failure).not.toHaveBeenCalled();
    release();
    await pending;
  } finally {
    release();
    await pending;
  }
}, 5000);

test('an unclaimed terminal failure cannot fail a successor with the same attempt number', async () => {
  await claim();
  const expectedState = (await tournamentInfoRepository.findSetupStatus(season, tournamentId))!;
  await claim();
  const failure = {
    attempt: 1,
    terminal: true,
    errorCode: 'CLAIM_FAILED',
    nextRetryAt: null,
    startedAt: new Date(),
  };
  expect(
    await tournamentInfoRepository.markSetupAttemptFailure(season, tournamentId, {
      ...failure,
      expectedState,
    }),
  ).toBe(false);
  expect((await tournamentInfoRepository.findSetupStatus(season, tournamentId))!.setupStatus).toBe(
    'processing',
  );
  expect(
    await tournamentInfoRepository.markSetupAttemptFailure(season, tournamentId, failure),
  ).toBe(false);
});

for (const sourceChanges of [false, true, 'omitted'] as const) {
  test(`league enrichment ${sourceChanges === 'omitted' ? 'rejects newly eligible omitted' : sourceChanges ? 'rejects changed' : 'accepts unchanged'} entry input after provider work`, async () => {
    const { syncLeagueEventResultsByTournament } = await import(
      '../../src/services/league-event-results.service'
    );
    const resolver = await import('../../src/services/tournament-entry-resolver.service');
    const live = await import('../../src/services/event-live-v2-score.service');
    const { eventRepository } = await import('../../src/repositories/events');
    const { playerRepository } = await import('../../src/repositories/players');
    const { entryEventResultsRepository } = await import(
      '../../src/repositories/entry-event-results'
    );
    const { leagueEventResultsRepository } = await import(
      '../../src/repositories/league-event-results'
    );
    const { ENTRY_SEASON_SYNC_LOCK_NAMESPACE } = await import(
      '../../src/repositories/entry-event-transfers'
    );
    const { fplClient } = await import('../../src/clients/fpl');
    const { tournamentEntryCoreScopes } = await import('../../src/domain/mutation-scope');
    const checkedAt = new Date(Date.now() + 60_000).toISOString();
    const picks = Array.from({ length: 15 }, (_, i) => ({
      element: i + 1,
      position: i + 1,
      multiplier: i === 0 ? 2 : i < 11 ? 1 : 0,
      is_captain: i === 0,
      is_vice_captain: i === 1,
    }));
    const omittedEntryId = tournamentId + 1;
    if (sourceChanges === 'omitted') {
      await sql`INSERT INTO competition.entries (season_id,entry_id,entry_name,player_name,started_event)
        VALUES (${season.seasonId},${omittedEntryId},'Omitted','Fixture',2)`;
    }
    spyOn(resolver, 'resolveTournamentEntryIds').mockResolvedValue(
      sourceChanges === 'omitted' ? [tournamentId, omittedEntryId] : [tournamentId],
    );
    spyOn(eventRepository, 'findById').mockResolvedValue(null);
    spyOn(live, 'loadFreshEventLiveAuthoritySnapshot').mockResolvedValue({
      publication: { sourceCheckedAt: checkedAt },
      eventLives: picks.map((pick) => ({ elementId: pick.element, totalPoints: 2 })),
    } as never);
    spyOn(playerRepository, 'findByIds').mockResolvedValue([]);
    spyOn(entryEventResultsRepository, 'findByEventAndEntryIds').mockResolvedValue([]);
    spyOn(entryEventResultsRepository, 'findEntryIdsNeedingRichSync').mockResolvedValue([
      tournamentId,
    ]);
    spyOn(fplClient, 'getEntryEventPicks').mockImplementation(async () => {
      // A competing writer can commit while the provider call is in progress.
      // The actual source-version read and mutation lock use the isolated PG.
      await withMutationScopes(
        {
          queueName: 'entry-sync',
          jobName: 'entry-info',
          scopes: tournamentEntryCoreScopes(season.seasonId, [
            sourceChanges === 'omitted' ? omittedEntryId : tournamentId,
          ]),
        },
        async () => {
          if (sourceChanges) {
            const tx = await getDbClient();
            if (sourceChanges === 'omitted') {
              await tx`UPDATE competition.entries SET started_event=1 WHERE season_id=${season.seasonId} AND entry_id=${omittedEntryId}`;
            } else {
              await tx`UPDATE competition.entries SET entry_name='new source' WHERE season_id=${season.seasonId} AND entry_id=${tournamentId}`;
            }
          }
        },
      );
      return {
        picks,
        automatic_subs: [],
        active_chip: null,
        entry_history: {
          event: 1,
          points: 24,
          total_points: 24,
          event_transfers_cost: 0,
          event_transfers: 0,
          overall_rank: 1,
          rank: 1,
          value: 1000,
          bank: 0,
        },
      } as never;
    });
    const reachedPublication = new Error('publication reached');
    const publish = spyOn(leagueEventResultsRepository, 'upsertBatch').mockImplementation(
      async () => {
        const writerCanLock = await sql.begin(async (tx) => {
          const [row] = await tx`SELECT pg_try_advisory_xact_lock(
            ${ENTRY_SEASON_SYNC_LOCK_NAMESPACE},
            hashint8((${season.seasonId}::bigint << 32) + ${tournamentId}::bigint)
          ) AS acquired`;
          return row!.acquired;
        });
        expect(writerCanLock).toBe(false);
        throw reachedPublication;
      },
    );
    const attempt = syncLeagueEventResultsByTournament(season, tournamentId, 1);
    if (sourceChanges) {
      await expect(attempt).rejects.toMatchObject({ code: 'LEAGUE_ENTRY_SOURCE_STALE' });
      expect(publish).not.toHaveBeenCalled();
    } else {
      await expect(attempt).rejects.toBe(reachedPublication);
      expect(publish).toHaveBeenCalledTimes(1);
    }
  });
}

test('the worker settles an ordinary provider error once a successor owns the setup', async () => {
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const setup = await import('../../src/services/tournament-setup.service');
  const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  let successor: Awaited<ReturnType<typeof claim>>;
  spyOn(setup, 'setupTournamentStructure').mockImplementation(async () => {
    successor = await claim();
    throw new Error('provider failed after successor claim');
  });
  await processTournamentSetupJob({
    id: 'integration-setup-stale-provider',
    name: 'tournament-setup',
    queueName: 'tournament-setup',
    data: { ...season, tournamentId, source: 'manual', triggeredAt: new Date().toISOString() },
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: async () => {},
  } as never);
  const status = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
  expect(status!.setupStatus).toBe('processing');
  expect(status!.setupStartedAt).toBe(successor!.startedAt);
  expect(status!.setupNextRetryAt).toBeNull();
});

async function prepareSetupPublicationTest() {
  const backfill = await import('../../src/services/tournament-backfill.service');
  const structure = await import('../../src/services/tournament-structure.service');
  const audit = await import('../../src/services/tournament-audit.service');
  const scheduler = await import('../../src/scheduler/scheduler.service');
  const reviewJobs = await import('../../src/jobs/maintenance.jobs');
  const repairJobs = await import('../../src/jobs/tournament-repair.jobs');
  const { tournamentEntryRepository } = await import('../../src/repositories/tournament-entries');
  const { eventRepository } = await import('../../src/repositories/events');
  spyOn(backfill, 'syncTournamentEntryDetails').mockResolvedValue([]);
  spyOn(backfill, 'ensureTournamentCoreResults').mockResolvedValue(undefined);
  spyOn(backfill, 'calculateTournamentHistoryFromStoredResults').mockResolvedValue(undefined);
  spyOn(backfill, 'enrichTournamentHistory').mockResolvedValue([]);
  spyOn(structure, 'rebuildTournamentStructure').mockResolvedValue(undefined);
  spyOn(audit, 'auditTournamentSetup').mockResolvedValue({ issues: [] } as never);
  spyOn(tournamentEntryRepository, 'findEntryIdsByTournamentId').mockResolvedValue([tournamentId]);
  spyOn(tournamentEntryRepository, 'findEntrySeedsByTournamentId').mockResolvedValue([]);
  spyOn(eventRepository, 'findLatestFinalized').mockResolvedValue({ id: 1 } as never);
  spyOn(scheduler, 'runCompatibilitySchedulerPass').mockResolvedValue({} as never);
  spyOn(reviewJobs, 'enqueueTournamentReview').mockResolvedValue(undefined as never);
  spyOn(repairJobs, 'enqueueTournamentRepair').mockResolvedValue(undefined as never);
  await sql`INSERT INTO fpl.events (season_id,event_id,name) VALUES (${season.seasonId},1,'Setup fixture event')`;
  await sql`UPDATE competition.tournaments SET group_started_event_id=1,group_ended_event_id=1 WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
}

test('a rolled-back SQL failure after standings can publish warnings in a fresh phase', async () => {
  await prepareSetupPublicationTest();
  const { setupTournamentStructure } = await import('../../src/services/tournament-setup.service');
  const progress = tournamentInfoRepository.markSetupProgress;
  spyOn(tournamentInfoRepository, 'markSetupProgress').mockImplementation(async (...args) => {
    if (args[2] === 'enriching_history') {
      const tx = await getDbClient();
      await tx`SELECT 1 / 0`;
    }
    return progress(...args);
  });
  await setupTournamentStructure(season, tournamentId, { execution: await claim() });
  const status = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
  expect(status!.setupStatus).toBe('ready');
  expect(status!.standingsReadyAt).not.toBeNull();
  expect(status!.setupWarningCount).toBeGreaterThan(0);
  const rows =
    await sql`SELECT diagnostic_code FROM competition.tournament_setup_issues WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId} AND resolved_at IS NULL`;
  expect(rows.map((row) => row.diagnostic_code)).toContain('22012');
});

test('a second setup for the same event reserves a new refresh after the first succeeded', async () => {
  await prepareSetupPublicationTest();
  const { setupTournamentStructure } = await import('../../src/services/tournament-setup.service');
  await setupTournamentStructure(season, tournamentId, { execution: await claim() });
  const scopeKey = `${season.seasonCode}:tournament:${tournamentId}`;
  await sql`UPDATE ops.scheduler_obligations SET status='succeeded' WHERE job_name='tournament-materialized-views-refresh' AND scope_key=${scopeKey}`;
  await setupTournamentStructure(season, tournamentId, { execution: await claim() });
  const rows =
    await sql`SELECT status,period_key FROM ops.scheduler_obligations WHERE job_name='tournament-materialized-views-refresh' AND scope_key=${scopeKey}`;
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((row) => row.period_key)).size).toBe(2);
  expect(rows.map((row) => row.status).sort()).toEqual(['pending', 'succeeded']);
});

test('official H2H rereads groups and entry totals after acquiring publication fences', async () => {
  const { ENTRY_SEASON_SYNC_LOCK_NAMESPACE } = await import(
    '../../src/repositories/entry-event-transfers'
  );
  const phases = await import('../../src/utils/tournament-setup-execution');
  const { tournamentSetupRebuildScopes, tournamentEntryCoreScopes } = await import(
    '../../src/domain/mutation-scope'
  );
  const { tournamentEntryRepository } = await import('../../src/repositories/tournament-entries');
  const { tournamentOfficialH2HRepository } = await import(
    '../../src/repositories/tournament-official-h2h'
  );
  const { tournamentOfficialH2HManifestRepository } = await import(
    '../../src/repositories/tournament-official-h2h-manifest'
  );
  const { fplClient } = await import('../../src/clients/fpl');
  const { syncOfficialH2HTournament } = await import(
    '../../src/services/tournament-official-h2h.service'
  );
  await sql`INSERT INTO fpl.events (season_id,event_id,name) VALUES (${season.seasonId},1,'H2H fixture')`;
  await sql`INSERT INTO competition.entry_event_results (season_id,entry_id,event_id,event_points,event_net_points) VALUES (${season.seasonId},${tournamentId},1,1,1)`;
  await sql`INSERT INTO competition.tournament_groups (season_id,tournament_id,entry_id,group_id,group_name,group_index) VALUES (${season.seasonId},${tournamentId},${tournamentId},1,'Old group',1)`;
  const owner = await claim();
  const tournament = {
    ...(await tournamentInfoRepository.findSetupConfig(season, tournamentId))!,
    leagueType: 'h2h',
    groupMode: 'battle_races',
    groupStartedEventId: 1,
    groupEndedEventId: 1,
  } as const;
  spyOn(tournamentEntryRepository, 'findEntryIdsByTournamentId').mockResolvedValue([tournamentId]);
  spyOn(tournamentOfficialH2HManifestRepository, 'findByTournament').mockResolvedValue([]);
  spyOn(fplClient, 'getLeagueH2HStandings').mockImplementation(async () => {
    expect(typeof (await getDbClient()).begin).toBe('function');
    return {
      standings: {
        results: [
          {
            entry: tournamentId,
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
  });
  spyOn(fplClient, 'getLeagueH2HMatches').mockResolvedValue({
    results: [],
    has_next: false,
  } as never);
  const scopes = [
    ...tournamentSetupRebuildScopes(tournamentId),
    ...tournamentEntryCoreScopes(season.seasonId, [tournamentId]),
  ];
  const originalPhase = phases.withTournamentSetupPhase;
  spyOn(phases, 'withTournamentSetupPhase').mockImplementation(async (...args) => {
    // Simulate an earlier cascade committing immediately before the H2H
    // publisher acquires its scopes. Old precomputed groupRows would be stale.
    await withMutationScopes(
      { queueName: 'test', jobName: 'competing-source-writer', scopes },
      async () => {
        const tx = await getDbClient();
        await tx`UPDATE competition.tournament_groups SET group_name='New group' WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
        await tx`UPDATE competition.entry_event_results SET event_points=20,event_net_points=20 WHERE season_id=${season.seasonId} AND entry_id=${tournamentId}`;
      },
    );
    return originalPhase(...args);
  });
  const publish = spyOn(tournamentOfficialH2HRepository, 'publish').mockImplementation(
    async (_season, _id, publication) => {
      expect(publication.groupRows[0]!.groupName).toBe('New group');
      expect(publication.groupRows[0]!.totalPoints).toBe(20);
      for (const scope of scopes) {
        await expect(
          sql.begin(async (tx) => {
            await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${scope} FOR UPDATE NOWAIT`;
          }),
        ).rejects.toMatchObject({ code: '55P03' });
      }
      const writerCanLock = await sql.begin(async (tx) => {
        const [row] = await tx`SELECT pg_try_advisory_xact_lock(
          ${ENTRY_SEASON_SYNC_LOCK_NAMESPACE},
          hashint8((${season.seasonId}::bigint << 32) + ${tournamentId}::bigint)
        ) AS acquired`;
        return row!.acquired;
      });
      expect(writerCanLock).toBe(false);
      return { groupRows: 1, battleRows: 0, knockoutRows: 0 } as never;
    },
  );
  await syncOfficialH2HTournament(season, tournament, undefined, { setupExecution: owner });
  expect(publish).toHaveBeenCalledTimes(1);
});

test('league eligibility changes cannot turn an empty write batch into success', async () => {
  const service = await import('../../src/services/league-event-results.service');
  const resolver = await import('../../src/services/tournament-entry-resolver.service');
  const { eventRepository } = await import('../../src/repositories/events');
  const { entryInfoRepository } = await import('../../src/repositories/entry-infos');
  const { leagueEventResultsRepository } = await import(
    '../../src/repositories/league-event-results'
  );
  spyOn(resolver, 'resolveTournamentEntryIds').mockResolvedValue([tournamentId]);
  spyOn(eventRepository, 'findById').mockResolvedValue(null);
  const original = entryInfoRepository.findByIds.bind(entryInfoRepository);
  spyOn(entryInfoRepository, 'findByIds').mockImplementation(async (...args) => {
    const rows = await original(...args);
    await sql`UPDATE competition.entries SET started_event=1 WHERE season_id=${season.seasonId} AND entry_id=${tournamentId}`;
    return rows;
  });
  await sql`UPDATE competition.entries SET started_event=2 WHERE season_id=${season.seasonId} AND entry_id=${tournamentId}`;
  const publish = spyOn(leagueEventResultsRepository, 'upsertBatch');
  await expect(
    service.syncLeagueEventResultsByTournament(season, tournamentId, 1),
  ).rejects.toMatchObject({ code: 'LEAGUE_ENTRY_SOURCE_STALE' });
  expect(publish).not.toHaveBeenCalled();
});

for (const intent of ['resume', 'roster-retry'] as const) {
  test(`unmarked manual setup cannot bypass committed ${intent} intent before queue handoff`, async () => {
    const seasonJobs = await import('../../src/services/season-scoped-job.service');
    const setup = await import('../../src/services/tournament-setup.service');
    const rosterJobs = await import('../../src/jobs/tournament-sync.jobs');
    const setupJobs = await import('../../src/jobs/tournament-setup.jobs');
    const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
    spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
    const run = spyOn(setup, 'setupTournamentStructure').mockResolvedValue(undefined);
    const rosterQueue = spyOn(rosterJobs, 'findTournamentRosterReconcileJob').mockResolvedValue(
      null,
    );
    const setupQueue = spyOn(setupJobs, 'findTournamentSetupJob').mockResolvedValue(null);
    await sql`UPDATE competition.tournaments SET state='inactive', roster_sync_status=${intent === 'resume' ? 'processing' : 'pending'},
    setup_status='pending',setup_phase='queued',setup_progress_updated_at='2095-01-01',
    roster_sync_execution_id=gen_random_uuid() WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
    await processTournamentSetupJob({
      id: 'integration-resume-before-handoff',
      name: 'tournament-setup',
      queueName: 'tournament-setup',
      data: { ...season, tournamentId, source: 'manual', triggeredAt: new Date().toISOString() },
      attemptsMade: 0,
      opts: { attempts: 3 },
      updateProgress: async () => {},
    } as never);
    expect(run).not.toHaveBeenCalled();
    expect(rosterQueue).not.toHaveBeenCalled();
    expect(setupQueue).not.toHaveBeenCalled();
    const status = await tournamentInfoRepository.findSetupStatus(season, tournamentId);
    expect(status!.setupStatus).toBe('pending');
    expect(status!.setupProgressUpdatedAt).toBe('2095-01-01 00:00:00+00');
  });
}

test('a legacy unmarked create delivery cannot supersede a newer setup marker', async () => {
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const setup = await import('../../src/services/tournament-setup.service');
  const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  const run = spyOn(setup, 'setupTournamentStructure').mockResolvedValue(undefined);
  await sql`UPDATE competition.tournaments
    SET state='active', roster_mode='snapshot', roster_sync_status=NULL,
        setup_status='pending', setup_phase='queued',
        setup_progress_updated_at='2095-01-02 00:00:00+00'
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;

  await processTournamentSetupJob({
    id: 'integration-legacy-create-delivery',
    name: 'tournament-setup',
    queueName: 'tournament-setup',
    data: {
      ...season,
      tournamentId,
      source: 'create',
      triggeredAt: '2095-01-01T00:00:00.000Z',
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: async () => {},
  } as never);

  expect(run).not.toHaveBeenCalled();
  expect(await tournamentInfoRepository.findSetupStatus(season, tournamentId)).toMatchObject({
    setupStatus: 'pending',
    setupProgressUpdatedAt: '2095-01-02 00:00:00+00',
  });
});

test('a legacy create retry keeps its claimed execution after its marker is preserved', async () => {
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const setup = await import('../../src/services/tournament-setup.service');
  const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  const run = spyOn(setup, 'setupTournamentStructure').mockResolvedValue(undefined);
  await sql`UPDATE competition.tournaments
    SET state='active', roster_mode='snapshot', roster_sync_status=NULL,
        setup_status='processing', setup_phase='queued', setup_attempt=1,
        setup_started_at='2095-01-01 00:00:01+00',
        setup_next_retry_at='2095-01-01 00:01:00+00',
        setup_last_error_code='SETUP_RETRYABLE',
        setup_progress_updated_at='2095-01-01 00:00:00+00'
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;

  await processTournamentSetupJob({
    id: 'integration-legacy-create-retry',
    name: 'tournament-setup',
    queueName: 'tournament-setup',
    data: {
      ...season,
      tournamentId,
      source: 'create',
      triggeredAt: '2095-01-01T00:00:00.000Z',
    },
    attemptsMade: 1,
    opts: { attempts: 3 },
    updateProgress: async () => {},
  } as never);

  expect(run).toHaveBeenCalledTimes(1);
  expect(await tournamentInfoRepository.findSetupStatus(season, tournamentId)).toMatchObject({
    setupStatus: 'processing',
    setupPhase: 'syncing_entries',
    setupAttempt: 2,
  });
});

test('a legacy create retry cannot supersede a newer marked execution in progress', async () => {
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const setup = await import('../../src/services/tournament-setup.service');
  const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  const run = spyOn(setup, 'setupTournamentStructure').mockResolvedValue(undefined);
  await sql`UPDATE competition.tournaments
    SET state='active', roster_mode='snapshot', roster_sync_status=NULL,
        setup_status='processing', setup_phase='building_structure', setup_attempt=1,
        setup_started_at='2095-01-02 00:00:01+00',
        setup_progress_updated_at='2095-01-02 00:00:00+00'
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;

  await processTournamentSetupJob({
    id: 'integration-legacy-create-active-new-owner',
    name: 'tournament-setup',
    queueName: 'tournament-setup',
    data: {
      ...season,
      tournamentId,
      source: 'create',
      triggeredAt: '2095-01-01T00:00:00.000Z',
    },
    attemptsMade: 1,
    opts: { attempts: 3 },
    updateProgress: async () => {},
  } as never);

  expect(run).not.toHaveBeenCalled();
  expect(await tournamentInfoRepository.findSetupStatus(season, tournamentId)).toMatchObject({
    setupStatus: 'processing',
    setupPhase: 'building_structure',
    setupProgressUpdatedAt: '2095-01-02 00:00:00+00',
  });
});

test('a marked admission error does not persist a stale pre-claim failure', async () => {
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const roster = await import('../../src/repositories/tournament-roster');
  const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  const admissionError = new Error('roster read failed');
  const failure = spyOn(tournamentInfoRepository, 'markSetupAttemptFailure');
  spyOn(roster.tournamentRosterRepository, 'findById').mockRejectedValue(admissionError);
  await sql`UPDATE competition.tournaments
    SET state='active', roster_mode='snapshot', roster_sync_status=NULL,
        setup_status='pending', setup_phase='queued',
        setup_progress_updated_at='2095-01-03 00:00:00+00'
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;

  await expect(
    processTournamentSetupJob({
      id: 'integration-marked-admission-error',
      name: 'tournament-setup',
      queueName: 'tournament-setup',
      data: {
        ...season,
        tournamentId,
        source: 'roster',
        setupMarker: '2095-01-03 00:00:00+00',
        triggeredAt: '2095-01-03T00:00:01.000Z',
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
      updateProgress: async () => {},
    } as never),
  ).rejects.toBe(admissionError);
  expect(failure).not.toHaveBeenCalled();
});

for (const rosterStatus of ['failed', 'processing'] as const) {
  test(`prepared manual retry of a failed official resume reaches setup execution with roster=${rosterStatus}`, async () => {
    const seasonJobs = await import('../../src/services/season-scoped-job.service');
    const setup = await import('../../src/services/tournament-setup.service');
    const setupJobs = await import('../../src/jobs/tournament-setup.jobs');
    const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
    spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
    const run = spyOn(setup, 'setupTournamentStructure').mockResolvedValue(undefined);
    let preparedMarkerForAssertion: string | undefined;
    await sql`UPDATE competition.tournaments SET state='inactive',roster_sync_status=${rosterStatus},
    setup_status='failed',setup_phase='failed',setup_error='terminal resume failure',
    setup_progress_updated_at='2095-01-01' WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
    spyOn(setupJobs, 'enqueueTournamentSetup').mockImplementation(
      async (_season, id, source, options) => {
        const preparedRetryMarker = await options?.prepareEnqueue?.();
        preparedMarkerForAssertion =
          typeof preparedRetryMarker === 'string' ? preparedRetryMarker : undefined;
        const prepared = await tournamentInfoRepository.findSetupStatus(season, id);
        expect(prepared!.setupStatus).toBe('processing');
        expect(prepared!.setupPhase).toBe('queued');
        await processTournamentSetupJob({
          id: 'integration-prepared-manual-retry',
          name: 'tournament-setup',
          queueName: 'tournament-setup',
          data: {
            ...season,
            tournamentId: id,
            source,
            triggeredAt: new Date().toISOString(),
            ...(typeof preparedRetryMarker === 'string' ? { preparedRetryMarker } : {}),
          },
          attemptsMade: 0,
          opts: { attempts: 3 },
          updateProgress: async () => {},
        } as never);
        return { id: 'integration-prepared-manual-retry' } as never;
      },
    );
    await setup.requeueTournamentSetup(season, tournamentId);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      season,
      tournamentId,
      expect.objectContaining({ progressMarker: preparedMarkerForAssertion }),
    );
    expect(
      (await tournamentInfoRepository.findSetupStatus(season, tournamentId))!.setupAttempt,
    ).toBe(1);
  });
}

test('requeue admission follows a prepared marker after setup progress advances', async () => {
  const setupJobs = await import('../../src/jobs/tournament-setup.jobs');
  const setup = await import('../../src/services/tournament-setup.service');
  const marker = '2095-01-03 00:00:00+00';
  await sql`UPDATE competition.tournaments
    SET setup_status='processing', setup_phase='building_structure',
        setup_progress_updated_at=${marker}
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;

  const findJob = spyOn(setupJobs, 'findTournamentSetupJob').mockResolvedValue({
    id: 'active-prepared-retry',
  } as never);
  const enqueue = spyOn(setupJobs, 'enqueueTournamentSetup').mockImplementation(
    async (_season, id, _source, options) => {
      expect(id).toBe(tournamentId);
      expect(options?.admissionMarker).toBe(marker);
      return { id: 'active-prepared-retry' } as never;
    },
  );

  await expect(setup.requeueTournamentSetup(season, tournamentId, marker)).resolves.toMatchObject({
    id: 'active-prepared-retry',
  });
  expect(findJob).toHaveBeenCalledWith(season, tournamentId, marker);
  expect(enqueue).toHaveBeenCalledTimes(1);
});

test('prepared retry keeps its durable reservation when queue admission fails', async () => {
  const setupJobs = await import('../../src/jobs/tournament-setup.jobs');
  const setup = await import('../../src/services/tournament-setup.service');
  const failure = new Error('queue unavailable');
  spyOn(setupJobs, 'findTournamentSetupJob').mockResolvedValue(null);
  spyOn(setupJobs, 'enqueueTournamentSetup').mockImplementation(
    async (_season, id, _source, options) => {
      const marker = await options?.prepareEnqueue?.();
      expect(id).toBe(tournamentId);
      expect(marker).toBeString();
      throw failure;
    },
  );

  await expect(setup.requeueTournamentSetup(season, tournamentId)).rejects.toBe(failure);
  expect(await tournamentInfoRepository.findSetupStatus(season, tournamentId)).toMatchObject({
    setupStatus: 'processing',
    setupPhase: 'queued',
    setupAttempt: 0,
  });
});

test('prepared setup retry marker runs without an official roster resume', async () => {
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const setup = await import('../../src/services/tournament-setup.service');
  const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
  const preparedRetryMarker = '2095-01-02 00:00:00+00';
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  const run = spyOn(setup, 'setupTournamentStructure').mockResolvedValue(undefined);
  await sql`UPDATE competition.tournaments
    SET state='active', roster_sync_status='ready', setup_status='processing', setup_phase='building_structure',
        setup_progress_updated_at=${preparedRetryMarker}
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;

  await processTournamentSetupJob({
    id: 'integration-prepared-ordinary-retry',
    name: 'tournament-setup',
    queueName: 'tournament-setup',
    data: {
      ...season,
      tournamentId,
      source: 'manual',
      triggeredAt: new Date().toISOString(),
      preparedRetryMarker,
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: async () => {},
  } as never);

  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith(
    season,
    tournamentId,
    expect.objectContaining({ progressMarker: preparedRetryMarker }),
  );
  expect((await tournamentInfoRepository.findSetupStatus(season, tournamentId))!.setupAttempt).toBe(
    1,
  );
});

test('prepared setup retry reclaims the current durable attempt after a stalled phase', async () => {
  const seasonJobs = await import('../../src/services/season-scoped-job.service');
  const setup = await import('../../src/services/tournament-setup.service');
  const { processTournamentSetupJob } = await import('../../src/workers/tournament-setup.worker');
  const preparedRetryMarker = '2095-01-04 00:00:00+00';
  spyOn(seasonJobs, 'requireCurrentSeasonForJob').mockResolvedValue(season);
  const run = spyOn(setup, 'setupTournamentStructure').mockResolvedValue(undefined);
  await sql`UPDATE competition.tournaments
    SET state='active', roster_sync_status='ready', setup_status='processing',
        setup_phase='building_structure', setup_progress_updated_at=${preparedRetryMarker},
        setup_started_at=clock_timestamp(), setup_attempt=3, setup_max_attempts=3
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;

  await processTournamentSetupJob({
    id: 'integration-prepared-stalled-retry',
    name: 'tournament-setup',
    queueName: 'tournament-setup',
    data: {
      ...season,
      tournamentId,
      source: 'manual',
      triggeredAt: new Date().toISOString(),
      preparedRetryMarker,
    },
    // BullMQ stalled redelivery has consumed a delivery slot, while the
    // durable execution remains on its final configured attempt.
    attemptsMade: 1,
    opts: { attempts: 3 },
    updateProgress: async () => {},
  } as never);

  expect(run).toHaveBeenCalledTimes(1);
  expect((await tournamentInfoRepository.findSetupStatus(season, tournamentId))!).toMatchObject({
    setupStatus: 'processing',
    setupPhase: 'syncing_entries',
    setupAttempt: 3,
  });
});
