import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import { tournamentSetupLifecycleScope } from '../../src/domain/mutation-scope';
import { tournamentSetupIssueRepository } from '../../src/repositories/tournament-setup-issues';
import { getDbClient } from '../../src/db/singleton';
import { withMutationScopes } from '../../src/utils/mutation-scopes';
import { withTournamentRepairPhase } from '../../src/utils/tournament-repair-phase';
const input = {
  issueKey: 'ENTRY_PROFILE_INCOMPLETE:all',
  code: 'ENTRY_PROFILE_INCOMPLETE',
  category: 'profiles',
  severity: 'warning',
  affectedEntryIds: [] as number[],
} as const;
const season = explicitSeasonRef('9697');
const tournamentId = 995_601;
let issueId: number;
const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
async function cleanup() {
  await sql`DELETE FROM competition.tournament_battle_group_results WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.tournament_review_obligations WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.entry_event_results WHERE season_id=${season.seasonId} AND entry_id IN (${tournamentId}, ${tournamentId + 1})`;
  await sql`DELETE FROM competition.tournament_points_group_results WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.tournament_groups WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM ops.mutation_scopes WHERE scope_key IN (${`entry-core:${season.seasonId}:${tournamentId}`}, ${`entry-core:${season.seasonId}:${tournamentId + 1}`})`;
  await sql`DELETE FROM competition.tournament_entries WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.tournament_setup_issues WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.entries WHERE season_id=${season.seasonId} AND entry_id IN (${tournamentId}, ${tournamentId + 1})`;
  await sql`DELETE FROM fpl.events WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM fpl.seasons WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM ops.mutation_scopes WHERE scope_key=${tournamentSetupLifecycleScope(tournamentId)}`;
}
beforeEach(async () => {
  await cleanup();
  await sql`INSERT INTO fpl.seasons (season_id,season_code,display_name,start_year,end_year,lifecycle_state)
    VALUES (${season.seasonId},${season.seasonCode},'Setup phases fixture',2096,2097,'reference_only')`;
  await sql`INSERT INTO competition.entries (season_id,entry_id,entry_name,player_name)
    VALUES (${season.seasonId},${tournamentId},'Fixture','Fixture')`;
  await sql`INSERT INTO competition.tournaments (season_id,tournament_id,name,creator,admin_entry_id,
    league_id,league_type,total_team_num,tournament_mode,group_mode,group_auto_averages,state,roster_mode,setup_status)
    VALUES (${season.seasonId},${tournamentId},'Fixture','integration-test',${tournamentId},${tournamentId},
    'classic',2,'normal','no_group',false,'active','official_sync','ready')`;
  await tournamentSetupIssueRepository.sync(season, tournamentId, [input]);
  issueId = (await tournamentSetupIssueRepository.listUnresolved(season, tournamentId))[0]!.issueId;
});
afterEach(async () => {
  mock.restore();
  await cleanup();
});
afterAll(() => sql.end());

async function capture() {
  const owner = await withMutationScopes(
    {
      queueName: 'tournament-repair',
      jobName: 'capture',
      tournamentId,
      scopes: [tournamentSetupLifecycleScope(tournamentId)],
    },
    () => tournamentSetupIssueRepository.lockRepairState(season, issueId),
  );
  expect(owner).not.toBeNull();
  return owner!;
}
test('renaming a tournament preserves the observed repair', async () => {
  const owner = await capture();
  await sql`UPDATE competition.tournaments SET name='Renamed', updated_at=clock_timestamp() WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  expect(await withTournamentRepairPhase(season, issueId, owner, [], async () => 'accepted')).toBe(
    'accepted',
  );
});
test('changed issue facts reject the old repair callback', async () => {
  const owner = await capture();
  await tournamentSetupIssueRepository.sync(season, tournamentId, [
    { ...input, diagnosticCode: 'NEW_FAILURE' },
  ]);
  let called = false;
  await expect(
    withTournamentRepairPhase(season, issueId, owner, [], async () => {
      called = true;
    }),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_REPAIR_STALE' });
  expect(called).toBe(false);
});
test('a changed tournament setup rejects prior repair work', async () => {
  const owner = await capture();
  await sql`UPDATE competition.tournaments SET setup_status='processing' WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await expect(
    withTournamentRepairPhase(season, issueId, owner, [], async () => {}),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_REPAIR_STALE' });
});

test('repair provider wait releases lifecycle lock and cannot resolve a newly recorded issue', async () => {
  const backfill = await import('../../src/services/tournament-backfill.service');
  const { repairTournamentSetupIssue } = await import(
    '../../src/services/tournament-repair.service'
  );
  await sql`INSERT INTO competition.tournament_entries (tournament_id,season_id,league_id,entry_id)
    VALUES (${tournamentId},${season.seasonId},${tournamentId},${tournamentId})`;
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
  const pending = repairTournamentSetupIssue(season, issueId).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await providerEntered;
    await withMutationScopes(
      {
        queueName: 'tournament-setup',
        jobName: 'new-issue',
        tournamentId,
        scopes: [tournamentSetupLifecycleScope(tournamentId)],
      },
      () =>
        tournamentSetupIssueRepository.sync(season, tournamentId, [
          { ...input, diagnosticCode: 'NEW_FAILURE' },
        ]),
    );
    release();
    expect(await pending).toMatchObject({ code: 'TOURNAMENT_REPAIR_STALE' });
    expect(await tournamentSetupIssueRepository.findUnresolvedById(season, issueId)).not.toBeNull();
  } finally {
    release();
    await pending;
  }
}, 5000);

test('an old failed job cannot consume retry budget for a new issue observation', async () => {
  const old = await capture();
  await tournamentSetupIssueRepository.sync(season, tournamentId, [
    { ...input, diagnosticCode: 'NEW_FAILURE' },
  ]);
  await tournamentSetupIssueRepository.recordRepairAttempt(
    issueId,
    new Date(),
    true,
    old.issueRevision,
  );
  expect(
    (await tournamentSetupIssueRepository.findUnresolvedById(season, issueId))!.repairAttempts,
  ).toBe(0);
  const current = await capture();
  await tournamentSetupIssueRepository.recordRepairAttempt(
    issueId,
    new Date(),
    false,
    current.issueRevision,
  );
  expect(
    (await tournamentSetupIssueRepository.findUnresolvedById(season, issueId))!.repairAttempts,
  ).toBe(1);
  await tournamentSetupIssueRepository.recordRepairAttempt(
    issueId,
    new Date(),
    false,
    current.issueRevision,
  );
  expect(
    (await tournamentSetupIssueRepository.findUnresolvedById(season, issueId))!.repairAttempts,
  ).toBe(1);
});

async function mockAudit(issues: string[]) {
  const audit = await import('../../src/services/tournament-audit.service');
  spyOn(audit, 'auditTournamentSetup').mockResolvedValue({
    issues,
    missingEntryInfoIds: [],
    missingEntryLeagueInfoIds: [],
  } as never);
}

test('successful repair commits issue resolution before returning', async () => {
  const { repairTournamentSetupIssue } = await import(
    '../../src/services/tournament-repair.service'
  );
  await mockAudit([]);
  await repairTournamentSetupIssue(season, issueId);
  expect(await tournamentSetupIssueRepository.findUnresolvedById(season, issueId)).toBeNull();
  const [row] =
    await sql`SELECT setup_warning_count FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  expect(row!.setup_warning_count).toBe(0);
});

test('resolved repair wakes headless reviews and preserves failure history and retry budgets', async () => {
  const { repairTournamentSetupIssue } = await import(
    '../../src/services/tournament-repair.service'
  );
  const { wakeTournamentReviewsAfterResolvedRepair } = await import(
    '../../src/services/tournament-review-publication.service'
  );
  const jobs = await import('../../src/jobs/maintenance.jobs');
  const enqueue = spyOn(jobs, 'enqueueTournamentReview').mockResolvedValue({} as never);
  for (const [eventId, state] of [
    [1, 'WAITING_SOURCE'],
    [2, 'DEGRADED'],
    [3, 'PROCESSING'],
    [4, 'DEGRADED'],
  ] as const) {
    await sql`INSERT INTO fpl.events(season_id,event_id,name) VALUES (${season.seasonId},${eventId},'Wake fixture')`;
    await sql`INSERT INTO competition.tournament_review_obligations
      (season_id,tournament_id,event_id,format,state,eligible_at,first_eligible_at,
       next_attempt_at,last_attempt_at,execution_attempts,source_rechecks,degraded_at,last_error_code,repair_issue_id)
      VALUES (${season.seasonId},${tournamentId},${eventId},'POINTS',${state},'2026-09-01','2026-09-01',
        clock_timestamp()+interval '1 hour','2026-09-02',2,39,'2026-09-03',
        ${eventId === 4 ? 'EXECUTION_FAILED' : 'TOURNAMENT_REVIEW_SOURCE_NOT_READY'},${issueId})`;
  }
  expect(await wakeTournamentReviewsAfterResolvedRepair(season)).toEqual([]);
  await mockAudit([]);
  await repairTournamentSetupIssue(season, issueId);
  expect(enqueue).toHaveBeenCalledTimes(2);
  const rows = await sql`SELECT event_id,state,execution_attempts,source_rechecks,
    first_eligible_at,degraded_at,repair_issue_id,next_attempt_at <= clock_timestamp() AS due
    FROM competition.tournament_review_obligations WHERE season_id=${season.seasonId} ORDER BY event_id`;
  expect(rows.map((row) => row.due)).toEqual([true, true, false, false]);
  expect(rows.map((row) => row.state)).toEqual([
    'WAITING_SOURCE',
    'DEGRADED',
    'PROCESSING',
    'DEGRADED',
  ]);
  for (const row of rows) {
    expect(row.execution_attempts).toBe(2);
    expect(row.source_rechecks).toBe(39);
    expect(new Date(row.first_eligible_at).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(new Date(row.degraded_at).toISOString()).toBe('2026-09-03T00:00:00.000Z');
    expect(Number(row.repair_issue_id)).toBe(issueId);
  }
  expect(await wakeTournamentReviewsAfterResolvedRepair(season)).toEqual([]);
  // Another failed validation after the repair must retain its new backoff.
  await sql`UPDATE competition.tournament_review_obligations
    SET last_attempt_at=clock_timestamp(),next_attempt_at=clock_timestamp()+interval '1 hour'
    WHERE season_id=${season.seasonId} AND event_id=2`;
  expect(await wakeTournamentReviewsAfterResolvedRepair(season)).toEqual([]);
});

test('repair wake is scoped, survives a missed enqueue, and rolls back with settlement', async () => {
  const { wakeTournamentReviewsAfterResolvedRepair } = await import(
    '../../src/services/tournament-review-publication.service'
  );
  await sql`INSERT INTO fpl.events(season_id,event_id,name) VALUES (${season.seasonId},1,'Wake rollback fixture')`;
  await sql`INSERT INTO competition.tournament_review_obligations
    (season_id,tournament_id,event_id,format,state,eligible_at,next_attempt_at,last_attempt_at,last_error_code,repair_issue_id)
    VALUES (${season.seasonId},${tournamentId},1,'POINTS','DEGRADED','2026-09-01',
      clock_timestamp()+interval '1 hour','2026-09-02','TOURNAMENT_REVIEW_SOURCE_NOT_READY',${issueId})`;
  await expect(
    withMutationScopes(
      {
        queueName: 'tournament-repair',
        jobName: 'wake-rollback',
        tournamentId,
        scopes: [tournamentSetupLifecycleScope(tournamentId)],
      },
      async () => {
        const tx = await getDbClient();
        await tx`UPDATE competition.tournament_setup_issues SET resolved_at=clock_timestamp() WHERE issue_id=${issueId}`;
        expect(await wakeTournamentReviewsAfterResolvedRepair(season, { tournamentId })).toEqual([
          1,
        ]);
        throw new Error('rollback wake');
      },
    ),
  ).rejects.toThrow('rollback wake');
  expect(await wakeTournamentReviewsAfterResolvedRepair(season)).toEqual([]);
  const [waiting] = await sql`SELECT next_attempt_at > clock_timestamp() AS waiting
    FROM competition.tournament_review_obligations WHERE season_id=${season.seasonId}`;
  expect(waiting.waiting).toBe(true);
  await sql`UPDATE competition.tournament_setup_issues SET resolved_at=clock_timestamp() WHERE issue_id=${issueId}`;
  expect(
    await wakeTournamentReviewsAfterResolvedRepair(season, { tournamentId: tournamentId + 1 }),
  ).toEqual([]);
  expect(await wakeTournamentReviewsAfterResolvedRepair(season, { eventId: 2 })).toEqual([]);
  expect(
    await wakeTournamentReviewsAfterResolvedRepair(season, { tournamentId, eventId: 1 }),
  ).toEqual([1]);
});

test('incomplete repair commits diagnostics and reports the new retry revision before throwing', async () => {
  const { repairTournamentSetupIssue } = await import(
    '../../src/services/tournament-repair.service'
  );
  const jobs = await import('../../src/jobs/tournament-repair.jobs');
  const queue = spyOn(jobs, 'enqueueTournamentRepair').mockImplementation(async () => {
    const current = await tournamentSetupIssueRepository.findUnresolvedById(season, issueId);
    expect(current!.internalMessage).toContain('missing entry_infos');
    return {} as never;
  });
  await mockAudit(['missing entry_infos']);
  const revisions: string[] = [];
  await expect(
    repairTournamentSetupIssue(season, issueId, (state) => revisions.push(state.issueRevision)),
  ).rejects.toThrow('repair remains incomplete');
  expect(queue).toHaveBeenCalledTimes(1);
  expect(revisions).toHaveLength(2);
  expect(revisions[1]).not.toBe(revisions[0]);
  await tournamentSetupIssueRepository.recordRepairAttempt(
    issueId,
    new Date(),
    false,
    revisions[1]!,
  );
  expect(
    (await tournamentSetupIssueRepository.findUnresolvedById(season, issueId))!.repairAttempts,
  ).toBe(1);
});

test('correction writes and issue resolution roll back together when settlement fails', async () => {
  const { repairTournamentSetupIssue } = await import(
    '../../src/services/tournament-repair.service'
  );
  const structure = await import('../../src/services/tournament-structure.service');
  const review = await import('../../src/services/tournament-review-publication.service');
  const { getDbClient } = await import('../../src/db/singleton');
  await tournamentSetupIssueRepository.sync(season, tournamentId, [
    {
      ...input,
      issueKey: 'STRUCTURE_INTEGRITY_FAILED:all',
      code: 'STRUCTURE_INTEGRITY_FAILED',
      category: 'results',
    },
  ]);
  issueId = (await tournamentSetupIssueRepository.listUnresolved(season, tournamentId))[0]!.issueId;
  await mockAudit([]);
  spyOn(structure, 'rebuildTournamentStructure').mockImplementation(
    async (_season, _tournament, _entrySeeds, options) => {
      options?.onCandidate?.({ groupRows: [], knockoutResults: [], battleMatchupKeys: [] });
      return [];
    },
  );
  const requestCorrection = review.requestTournamentReviewTournamentCorrection;
  const correction = spyOn(
    review,
    'requestTournamentReviewTournamentCorrection',
  ).mockImplementation(async (...args) => {
    // Exercise the real correction SQL within the enclosing repair transaction.
    await requestCorrection(...args);
    const tx = await getDbClient();
    await tx`UPDATE competition.tournament_setup_issues SET diagnostic_code='correction-marker' WHERE issue_id=${issueId}`;
    return [];
  });
  const originalSync = tournamentSetupIssueRepository.sync;
  spyOn(tournamentSetupIssueRepository, 'sync').mockImplementation(async (...args) => {
    await originalSync(...args);
    throw new Error('settlement failed after correction');
  });
  await expect(repairTournamentSetupIssue(season, issueId)).rejects.toThrow(
    'settlement failed after correction',
  );
  expect(correction).toHaveBeenCalledTimes(1);
  const issue = await tournamentSetupIssueRepository.findUnresolvedById(season, issueId);
  expect(issue).not.toBeNull();
  expect(issue!.diagnosticCode).toBeNull();
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

test('selection repair holds all entrant scopes, including entrants outside the issue subset', async () => {
  const { tournamentEntryCoreScopes } = await import('../../src/domain/mutation-scope');
  const { tournamentEntryRepository } = await import('../../src/repositories/tournament-entries');
  const selection = await import('../../src/services/tournament-selection-stats.service');
  const { repairTournamentSetupIssue } = await import(
    '../../src/services/tournament-repair.service'
  );
  await tournamentSetupIssueRepository.sync(season, tournamentId, [
    {
      ...input,
      issueKey: 'SELECTION_INSIGHTS_INCOMPLETE:1',
      code: 'SELECTION_INSIGHTS_INCOMPLETE',
      category: 'insights',
      eventId: 1,
      affectedEntryIds: [tournamentId],
    },
  ]);
  issueId = (await tournamentSetupIssueRepository.listUnresolved(season, tournamentId))[0]!.issueId;
  const entrants = [tournamentId, tournamentId + 1];
  const scopes = [
    tournamentSetupLifecycleScope(tournamentId),
    ...tournamentEntryCoreScopes(season.seasonId, entrants),
  ];
  await withMutationScopes(
    { queueName: 'test', jobName: 'seed-entry-scopes', scopes },
    async () => {},
  );
  spyOn(tournamentEntryRepository, 'findEntryIdsByTournamentId').mockResolvedValue(entrants);
  await mockAudit([]);
  const publish = spyOn(selection, 'syncTournamentSelectionStats').mockImplementation(async () => {
    for (const scope of scopes) {
      await expect(
        sql.begin(async (tx) => {
          await tx`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${scope} FOR UPDATE NOWAIT`;
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    }
    return { failedUnits: 0, rows: 2 } as never;
  });
  await repairTournamentSetupIssue(season, issueId);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(await tournamentSetupIssueRepository.findUnresolvedById(season, issueId)).toBeNull();
});

test('pre-capture failure accounts only for its still-due occurrence', async () => {
  const triggeredAt = new Date(Date.now() + 1000);
  const attemptedAt = new Date(triggeredAt.getTime() + 1000);
  const revision = await tournamentSetupIssueRepository.findDueDeliveryRevision(
    season,
    issueId,
    triggeredAt,
    attemptedAt,
  );
  expect(revision).not.toBeNull();
  await tournamentSetupIssueRepository.recordRepairAttempt(
    issueId,
    new Date(attemptedAt.getTime() + 86400000),
    true,
    revision!,
  );
  const issue = await tournamentSetupIssueRepository.findUnresolvedById(season, issueId);
  expect(issue?.repairAttempts).toBe(1);
  expect(issue?.repairExhaustedAt).not.toBeNull();
  expect(
    await tournamentSetupIssueRepository.findDueDeliveryRevision(
      season,
      issueId,
      triggeredAt,
      attemptedAt,
    ),
  ).toBeNull();
});

test('pre-capture fallback cannot adopt an occurrence observed after enqueue', async () => {
  const triggeredAt = new Date(Date.now() - 1000);
  await tournamentSetupIssueRepository.sync(season, tournamentId, [input]);
  expect(
    await tournamentSetupIssueRepository.findDueDeliveryRevision(
      season,
      issueId,
      triggeredAt,
      new Date(),
    ),
  ).toBeNull();
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

test('identical periodic observations preserve active repair and its due time', async () => {
  const due = new Date(Date.now() - 1000);
  await tournamentSetupIssueRepository.sync(season, tournamentId, [
    { ...input, nextRepairAt: due },
  ]);
  const owner = await capture();
  const [before] =
    await sql`SELECT xmin::text AS physical_revision, last_seen_at FROM competition.tournament_setup_issues WHERE issue_id=${issueId}`;
  for (let pass = 0; pass < 3; pass++) {
    await tournamentSetupIssueRepository.sync(season, tournamentId, [
      { ...input, nextRepairAt: new Date(Date.now() + 300000) },
    ]);
  }
  const [after] =
    await sql`SELECT xmin::text AS physical_revision, last_seen_at FROM competition.tournament_setup_issues WHERE issue_id=${issueId}`;
  expect(after!.physical_revision).not.toBe(before!.physical_revision);
  expect(after!.last_seen_at.getTime()).toBeGreaterThanOrEqual(before!.last_seen_at.getTime());
  expect((await capture()).issueRevision).toBe(owner.issueRevision);
  expect(
    (await tournamentSetupIssueRepository.findUnresolvedById(season, issueId))!.nextRepairAt,
  ).toEqual(due);
  expect(await withTournamentRepairPhase(season, issueId, owner, [], async () => 'accepted')).toBe(
    'accepted',
  );
  await tournamentSetupIssueRepository.recordRepairAttempt(
    issueId,
    new Date(Date.now() + 600000),
    false,
    owner.issueRevision,
  );
  expect((await capture()).issueRevision).not.toBe(owner.issueRevision);
  await expect(
    withTournamentRepairPhase(season, issueId, owner, [], async () => {}),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_REPAIR_STALE' });
});

test('resolution and identical reappearance reject the prior occurrence without losing first-seen evidence', async () => {
  const before = await tournamentSetupIssueRepository.findUnresolvedById(season, issueId);
  const owner = await capture();
  await tournamentSetupIssueRepository.sync(season, tournamentId, []);
  await tournamentSetupIssueRepository.sync(season, tournamentId, [input]);
  const after = await tournamentSetupIssueRepository.findUnresolvedById(season, issueId);
  expect(after!.firstSeenAt).toEqual(before!.firstSeenAt);
  expect((await capture()).issueRevision).not.toBe(owner.issueRevision);
  await expect(
    withTournamentRepairPhase(season, issueId, owner, [], async () => {}),
  ).rejects.toMatchObject({ code: 'TOURNAMENT_REPAIR_STALE' });
});

for (const topology of ['valid', 'missing', 'wrong-member'] as const) {
  test(`points structure repair rechecks ${topology} canonical groups before pruning results`, async () => {
    const { repairTournamentSetupIssue } = await import(
      '../../src/services/tournament-repair.service'
    );
    const review = await import('../../src/services/tournament-review-publication.service');
    const jobs = await import('../../src/jobs/tournament-repair.jobs');
    spyOn(jobs, 'enqueueTournamentRepair').mockResolvedValue({} as never);
    const correction = spyOn(
      review,
      'requestTournamentReviewTournamentCorrection',
    ).mockResolvedValue([]);
    await sql`INSERT INTO fpl.events(season_id,event_id,name) VALUES (${season.seasonId},1,'Guard fixture')`;
    await sql`UPDATE competition.tournaments SET total_team_num=1,group_mode='points_races',
      group_num=1,group_team_num=1,group_started_event_id=1,group_ended_event_id=1,knockout_mode='no_knockout'
      WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
    await sql`INSERT INTO competition.tournament_entries(season_id,tournament_id,league_id,entry_id)
      VALUES (${season.seasonId},${tournamentId},${tournamentId},${tournamentId})`;
    await sql`INSERT INTO competition.entries(season_id,entry_id,entry_name,player_name)
      VALUES (${season.seasonId},${tournamentId + 1},'Other','Other')`;
    if (topology !== 'missing') {
      await sql`INSERT INTO competition.tournament_groups(season_id,tournament_id,group_id,group_name,group_index,entry_id)
        VALUES (${season.seasonId},${tournamentId},1,'A',1,${topology === 'valid' ? tournamentId : tournamentId + 1})`;
    }
    await sql`INSERT INTO competition.tournament_points_group_results(season_id,tournament_id,group_id,event_id,entry_id,event_points,event_net_points)
      VALUES (${season.seasonId},${tournamentId},1,1,${tournamentId},42,42)`;
    await tournamentSetupIssueRepository.sync(season, tournamentId, [
      {
        ...input,
        issueKey: 'STRUCTURE_INTEGRITY_FAILED:all',
        code: 'STRUCTURE_INTEGRITY_FAILED',
        category: 'results',
        diagnosticCode: 'TOURNAMENT_REVIEW_STRUCTURE_INTEGRITY',
      },
    ]);
    issueId = (await tournamentSetupIssueRepository.listUnresolved(season, tournamentId))[0]!
      .issueId;
    await repairTournamentSetupIssue(season, issueId);
    const results = await sql`SELECT event_points FROM competition.tournament_points_group_results
      WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
    // A result that is valid under the rebuilt canonical topology must remain
    // visible even when the pre-repair snapshot classified its old topology as
    // missing or wrong-member.
    expect(results).toHaveLength(1);
    expect(results[0]!.event_points).toBe(42);
    expect(correction).toHaveBeenCalledTimes(topology === 'valid' ? 0 : 1);
    const groups =
      await sql`SELECT entry_id FROM competition.tournament_groups WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
    expect(groups.map((row) => row.entry_id)).toEqual([tournamentId]);
    expect(await tournamentSetupIssueRepository.findUnresolvedById(season, issueId)).toBeNull();
  });
}

test('mixed points and knockout tournaments retain the existing structural repair path', async () => {
  const { repairTournamentSetupIssue } = await import(
    '../../src/services/tournament-repair.service'
  );
  const structure = await import('../../src/services/tournament-structure.service');
  const review = await import('../../src/services/tournament-review-publication.service');
  await sql`UPDATE competition.tournaments SET group_mode='points_races',knockout_mode='single_elimination'
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await tournamentSetupIssueRepository.sync(season, tournamentId, [
    {
      ...input,
      issueKey: 'STRUCTURE_INTEGRITY_FAILED:all',
      code: 'STRUCTURE_INTEGRITY_FAILED',
      category: 'results',
    },
  ]);
  issueId = (await tournamentSetupIssueRepository.listUnresolved(season, tournamentId))[0]!.issueId;
  await mockAudit([]);
  const rebuild = spyOn(structure, 'rebuildTournamentStructure').mockImplementation(
    async (_season, _tournament, _entrySeeds, options) => {
      options?.onCandidate?.({ groupRows: [], knockoutResults: [], battleMatchupKeys: [] });
      return [];
    },
  );
  spyOn(review, 'requestTournamentReviewTournamentCorrection').mockResolvedValue([]);
  await repairTournamentSetupIssue(season, issueId);
  expect(rebuild).toHaveBeenCalledTimes(1);
});

for (const outcome of ['complete', 'failed', 'skipped'] as const) {
  test(`official result repair ${outcome} uses the exact event outside the database transaction`, async () => {
    const { repairTournamentSetupIssue } = await import(
      '../../src/services/tournament-repair.service'
    );
    const official = await import('../../src/services/tournament-official-h2h.service');
    const backfill = await import('../../src/services/tournament-backfill.service');
    const review = await import('../../src/services/tournament-review-publication.service');
    const { databaseTransactionStorage } = await import('../../src/db/singleton');
    await sql`INSERT INTO fpl.events(season_id,event_id,name,finished,data_checked,data_checked_at)
      VALUES (${season.seasonId},1,'Official repair',true,true,'2026-09-01')`;
    await sql`UPDATE competition.tournaments SET league_type='h2h',group_mode='battle_races',roster_mode='official_sync',group_started_event_id=1,group_ended_event_id=1
      WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
    await sql`INSERT INTO competition.tournament_entries(season_id,tournament_id,league_id,entry_id)
      VALUES (${season.seasonId},${tournamentId},${tournamentId},${tournamentId})`;
    await tournamentSetupIssueRepository.sync(season, tournamentId, [
      {
        ...input,
        issueKey: 'TOURNAMENT_RESULTS_INCOMPLETE:1',
        code: 'TOURNAMENT_RESULTS_INCOMPLETE',
        category: 'results',
        eventId: 1,
      },
    ]);
    issueId = (await tournamentSetupIssueRepository.listUnresolved(season, tournamentId))[0]!
      .issueId;
    await mockAudit([]);
    spyOn(backfill, 'runTournamentEventBackfill').mockResolvedValue([]);
    spyOn(review, 'requestTournamentReviewCorrection').mockResolvedValue([]);
    const refresh = spyOn(official, 'syncOfficialH2HTournament').mockImplementation(async () => {
      expect(databaseTransactionStorage.getStore()).toBeUndefined();
      if (outcome === 'failed') throw new Error('official provider unavailable');
      return { updatedGroups: 2, updatedResults: 1, skipped: outcome === 'skipped' ? 1 : 0 };
    });
    if (outcome === 'complete') {
      await repairTournamentSetupIssue(season, issueId);
      expect(await tournamentSetupIssueRepository.findUnresolvedById(season, issueId)).toBeNull();
    } else {
      await expect(repairTournamentSetupIssue(season, issueId)).rejects.toThrow(
        outcome === 'failed'
          ? 'official provider unavailable'
          : 'Official H2H results repair remains incomplete',
      );
      expect(
        await tournamentSetupIssueRepository.findUnresolvedById(season, issueId),
      ).not.toBeNull();
    }
    expect(refresh).toHaveBeenCalledWith(season, expect.objectContaining({ id: tournamentId }), 1, {
      finalizedThroughEventId: 1,
    });
  });
}

test('historical points repairs attach only the earliest missing scope on each validation', async () => {
  const review = await import('../../src/services/tournament-review-publication.service');
  const jobs = await import('../../src/jobs/tournament-repair.jobs');
  const queued: number[] = [];
  spyOn(jobs, 'enqueueTournamentRepair').mockImplementation(async (_season, issue) => {
    queued.push(issue.eventId!);
    return {} as never;
  });
  for (const eventId of [1, 2, 3])
    await sql`INSERT INTO fpl.events(season_id,event_id,name) VALUES (${season.seasonId},${eventId},'Historical guard fixture')`;
  const attached = await review.enqueueTournamentReviewRepair(
    season,
    {
      tournament_id: tournamentId,
      event_id: 3,
    } as Parameters<typeof review.enqueueTournamentReviewRepair>[1],
    new review.TournamentReviewSourceNotReadyError(
      'historical points group assignment is stale',
      [2, 1],
    ),
    new Date(),
  );
  expect(attached).not.toBeNull();
  expect(queued).toEqual([1]);
  const issues = (await tournamentSetupIssueRepository.listUnresolved(season, tournamentId)).filter(
    (i) => i.code === 'TOURNAMENT_RESULTS_INCOMPLETE',
  );
  expect(issues.map((i) => i.eventId)).toEqual([1]);
  expect(issues.some((i) => i.issueId === attached)).toBe(true);
  // The data for event 1 was repaired, but the worker exited before issue
  // finalization. A fresh event-2 diagnostic must not orphan the attached issue.
  const retained = await review.enqueueTournamentReviewRepair(
    season,
    { tournament_id: tournamentId, event_id: 3, repair_issue_id: attached } as Parameters<
      typeof review.enqueueTournamentReviewRepair
    >[1],
    new review.TournamentReviewSourceNotReadyError('historical points group assignment is stale', [
      2,
    ]),
    new Date(),
  );
  expect(retained).toBe(attached);
  expect(queued).toEqual([1, 1]);
  const unfinished = (
    await tournamentSetupIssueRepository.listUnresolved(season, tournamentId)
  ).filter((candidate) => candidate.code === 'TOURNAMENT_RESULTS_INCOMPLETE');
  expect(unfinished).toHaveLength(1);
  expect(unfinished[0]!.issueId).toBe(attached!);
  // Only after normal issue finalization may the next missing scope be attached.
  await sql`UPDATE competition.tournament_setup_issues SET resolved_at=clock_timestamp()
    WHERE issue_id=${attached!} AND season_id=${season.seasonId}`;
  const nextAttached = await review.enqueueTournamentReviewRepair(
    season,
    { tournament_id: tournamentId, event_id: 3, repair_issue_id: attached } as Parameters<
      typeof review.enqueueTournamentReviewRepair
    >[1],
    new review.TournamentReviewSourceNotReadyError('historical points group assignment is stale', [
      2,
    ]),
    new Date(),
  );
  expect(queued).toEqual([1, 1, 2]);
  const remaining = (
    await tournamentSetupIssueRepository.listUnresolved(season, tournamentId)
  ).filter((candidate) => candidate.code === 'TOURNAMENT_RESULTS_INCOMPLETE');
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toMatchObject({ eventId: 2, issueId: nextAttached });
});

test('points upsert corrects group-only changes without accepting an older source', async () => {
  const { tournamentPointsGroupResultsRepository } = await import(
    '../../src/repositories/tournament-points-group-results'
  );
  await sql`INSERT INTO fpl.events(season_id,event_id,name) VALUES (${season.seasonId},1,'Group update fixture')`;
  const sourceUpdatedAt = new Date('2026-09-01T12:00:00Z');
  const row = {
    tournamentId,
    entryId: tournamentId,
    eventId: 1,
    groupId: 2,
    eventPoints: 42,
    eventNetPoints: 42,
    sourceUpdatedAt,
  };
  expect(await tournamentPointsGroupResultsRepository.upsertBatch(season, [row])).toBe(1);
  expect(
    await tournamentPointsGroupResultsRepository.upsertBatch(season, [{ ...row, groupId: 1 }]),
  ).toBe(1);
  expect(
    await tournamentPointsGroupResultsRepository.upsertBatch(season, [
      { ...row, groupId: 3, sourceUpdatedAt: new Date('2026-08-31T12:00:00Z') },
    ]),
  ).toBe(0);
  const [stored] =
    await sql`SELECT group_id,event_points FROM competition.tournament_points_group_results WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  expect(stored).toMatchObject({ group_id: 1, event_points: 42 });
});

test('late historical points standings cannot replace a newer cumulative window', async () => {
  const { tournamentGroupRepository } = await import('../../src/repositories/tournament-groups');
  const row = {
    tournamentId,
    groupId: 1,
    groupName: 'A',
    groupIndex: 1,
    entryId: tournamentId,
    played: 2,
    totalNetPoints: 90,
    groupPoints: 90,
    totalPoints: 94,
    totalTransfersCost: 4,
    groupRank: 1,
  };
  const options = { preserveLaterStandings: true };
  expect(await tournamentGroupRepository.upsertBatch(season, [row], options)).toBe(1);
  expect(
    await tournamentGroupRepository.upsertBatch(
      season,
      [
        {
          ...row,
          played: 1,
          totalNetPoints: 40,
          groupPoints: 40,
          totalPoints: 40,
          totalTransfersCost: 0,
          groupRank: 2,
        },
      ],
      options,
    ),
  ).toBe(0);
  const [current] =
    await sql`SELECT played,group_points,total_points,total_transfers_cost,group_rank
    FROM competition.tournament_groups WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  expect(current).toMatchObject({
    played: 2,
    group_points: 90,
    total_points: 94,
    total_transfers_cost: 4,
    group_rank: 1,
  });
  // A genuine correction to the same current window still updates the totals.
  expect(
    await tournamentGroupRepository.upsertBatch(
      season,
      [{ ...row, groupPoints: 91, totalNetPoints: 91 }],
      options,
    ),
  ).toBe(1);
  const [corrected] = await sql`SELECT played,group_points FROM competition.tournament_groups
    WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  expect(corrected).toMatchObject({ played: 2, group_points: 91 });
});

for (const gap of [
  'missing-group',
  'missing-result',
  'stale-score',
  'stale-watermark',
  'stale-rank',
  'wrong-group',
  'complete',
  'joined-later',
] as const) {
  test(`review routes ${gap} history to its actual event scope`, async () => {
    const { buildPointsPayload, TournamentReviewSourceNotReadyError } = await import(
      '../../src/services/tournament-review-publication.service'
    );
    const checkedAt = new Date('2026-09-01T00:00:00Z');
    for (const eventId of [1, 2]) {
      await sql`INSERT INTO fpl.events(season_id,event_id,name,finished,data_checked,data_checked_at)
        VALUES (${season.seasonId},${eventId},'History scope fixture',true,true,${checkedAt})`;
    }
    await sql`UPDATE competition.tournaments SET total_team_num=1,group_mode='points_races',group_started_event_id=1,group_ended_event_id=2
      WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
    await sql`UPDATE competition.entries SET started_event=${gap === 'joined-later' ? 2 : 1}
      WHERE season_id=${season.seasonId} AND entry_id=${tournamentId}`;
    await sql`INSERT INTO competition.tournament_entries(season_id,tournament_id,league_id,entry_id)
      VALUES (${season.seasonId},${tournamentId},${tournamentId},${tournamentId})`;
    await sql`INSERT INTO competition.tournament_groups(season_id,tournament_id,group_id,group_name,group_index,entry_id)
      VALUES (${season.seasonId},${tournamentId},1,'A',1,${tournamentId})`;
    for (const eventId of [1, 2]) {
      await sql`INSERT INTO competition.entry_event_results(season_id,entry_id,event_id,event_points,event_transfers_cost,event_net_points,rich_synced_at,updated_at)
        VALUES (${season.seasonId},${tournamentId},${eventId},42,0,42,${checkedAt},${checkedAt})`;
      if (eventId === 1 && (gap === 'missing-group' || gap === 'joined-later')) continue;
      await sql`INSERT INTO competition.tournament_points_group_results(season_id,tournament_id,group_id,event_id,entry_id,event_points,event_cost,event_net_points,event_group_rank)
        VALUES (${season.seasonId},${tournamentId},${eventId === 1 && gap === 'wrong-group' ? 2 : 1},${eventId},${tournamentId},42,0,42,1)`;
    }
    if (gap === 'missing-result')
      await sql`DELETE FROM competition.entry_event_results WHERE season_id=${season.seasonId} AND entry_id=${tournamentId} AND event_id=1`;
    if (gap === 'stale-score')
      await sql`UPDATE competition.tournament_points_group_results SET event_points=43,event_net_points=43 WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId} AND event_id=1`;
    if (gap === 'stale-rank')
      await sql`UPDATE competition.tournament_points_group_results SET event_group_rank=2 WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId} AND event_id=1`;
    if (gap === 'stale-watermark')
      await sql`UPDATE competition.tournament_points_group_results SET updated_at='2026-08-31T00:00:00Z' WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId} AND event_id=1`;
    const run = () =>
      sql.begin((tx) =>
        buildPointsPayload(
          tx,
          season.seasonId,
          {
            tournament_id: tournamentId,
            total_team_num: 1,
            group_started_event_id: 1,
            group_ended_event_id: 2,
          } as Parameters<typeof buildPointsPayload>[2],
          { event_id: 2, data_checked_at: checkedAt } as Parameters<typeof buildPointsPayload>[3],
          {},
        ),
      );
    if (gap === 'complete' || gap === 'joined-later') {
      const result = await run();
      expect(result.rowCount).toBe(1);
      expect(result.readySubjectCount).toBe(1);
    } else {
      const failure = await run().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(TournamentReviewSourceNotReadyError);
      expect(failure).toMatchObject({ repairEventIds: [1] });
    }
  });
}

for (const gap of [
  'missing-history',
  'official-watermark',
  'official-score',
  'official-stale',
  'score',
  'watermark',
  'rank',
  'match-points',
  'complete',
] as const) {
  test(`H2H review routes ${gap} to the historical round instead of the current review`, async () => {
    const { buildH2HPayload, TournamentReviewSourceNotReadyError } = await import(
      '../../src/services/tournament-review-publication.service'
    );
    const checkedAt = new Date('2026-09-01T00:00:00Z');
    await sql`INSERT INTO competition.entries(season_id,entry_id,entry_name,player_name,started_event)
      VALUES (${season.seasonId},${tournamentId + 1},'Opponent','Fixture',1)`;
    await sql`UPDATE competition.entries SET started_event=1 WHERE season_id=${season.seasonId} AND entry_id=${tournamentId}`;
    for (const [index, entryId] of [tournamentId, tournamentId + 1].entries()) {
      await sql`INSERT INTO competition.tournament_entries(season_id,tournament_id,league_id,entry_id)
        VALUES (${season.seasonId},${tournamentId},${tournamentId},${entryId})`;
      await sql`INSERT INTO competition.tournament_groups(season_id,tournament_id,group_id,group_name,group_index,entry_id)
        VALUES (${season.seasonId},${tournamentId},1,'A',${index + 1},${entryId})`;
    }
    for (const eventId of [1, 2]) {
      await sql`INSERT INTO fpl.events(season_id,event_id,name,finished,data_checked,data_checked_at)
        VALUES (${season.seasonId},${eventId},'H2H history fixture',true,true,${checkedAt})`;
      for (const [index, entryId] of [tournamentId, tournamentId + 1].entries()) {
        await sql`INSERT INTO competition.entry_event_results(season_id,entry_id,event_id,event_points,event_transfers_cost,event_net_points,event_rank,overall_points,overall_rank,rich_synced_at,updated_at)
          VALUES (${season.seasonId},${entryId},${eventId},${42 - index * 2},0,${42 - index * 2},${index + 1},100,${index + 1},${checkedAt},${checkedAt})`;
      }
      if (eventId === 1 && gap === 'missing-history') continue;
      await sql`INSERT INTO competition.tournament_battle_group_results
        (season_id,tournament_id,group_id,event_id,home_index,home_entry_id,home_net_points,home_rank,home_match_points,
         away_index,away_entry_id,away_net_points,away_rank,away_match_points,source_checked_at,updated_at)
        VALUES (${season.seasonId},${tournamentId},1,${eventId},1,${tournamentId},42,1,3,2,${tournamentId + 1},40,2,0,${checkedAt},${checkedAt})`;
    }
    if (gap === 'score')
      await sql`UPDATE competition.tournament_battle_group_results SET home_net_points=43 WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId} AND event_id=1`;
    if (gap === 'watermark')
      await sql`UPDATE competition.entry_event_results SET updated_at='2026-09-02' WHERE season_id=${season.seasonId} AND event_id=1`;
    if (gap.startsWith('official-')) {
      await sql`UPDATE competition.tournament_battle_group_results SET source_order=0,official_match_id=event_id
        WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
      await sql`UPDATE competition.entry_event_results SET updated_at='2026-09-02',rich_synced_at='2026-09-02'
        WHERE season_id=${season.seasonId}`;
      if (gap === 'official-score')
        await sql`UPDATE competition.tournament_battle_group_results SET home_net_points=43
        WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId} AND event_id=1`;
      if (gap === 'official-stale')
        await sql`UPDATE competition.tournament_battle_group_results SET source_checked_at='2026-08-31'
        WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId} AND event_id=1`;
    }
    if (gap === 'rank')
      await sql`UPDATE competition.tournament_battle_group_results SET home_rank=99 WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId} AND event_id=1`;
    if (gap === 'match-points')
      await sql`UPDATE competition.tournament_battle_group_results SET home_match_points=0 WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId} AND event_id=1`;
    const run = () =>
      sql.begin((tx) =>
        buildH2HPayload(
          tx,
          season.seasonId,
          {
            tournament_id: tournamentId,
            total_team_num: 2,
            group_started_event_id: 1,
          } as Parameters<typeof buildH2HPayload>[2],
          { event_id: 2, data_checked_at: checkedAt } as Parameters<typeof buildH2HPayload>[3],
          {},
        ),
      );
    if (gap === 'complete' || gap === 'official-watermark') {
      expect((await run()).readySubjectCount).toBe(2);
    } else {
      const failure = await run().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(TournamentReviewSourceNotReadyError);
      expect(failure).toMatchObject({ repairEventIds: [1] });
    }
  });
}
