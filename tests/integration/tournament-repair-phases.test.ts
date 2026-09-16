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
  spyOn(structure, 'rebuildTournamentStructure').mockResolvedValue(undefined);
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
  test(`points structure repair rechecks ${topology} canonical groups before deleting results`, async () => {
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
    expect(results).toHaveLength(topology === 'valid' ? 1 : 0);
    if (topology === 'valid') expect(results[0]!.event_points).toBe(42);
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
  const rebuild = spyOn(structure, 'rebuildTournamentStructure').mockResolvedValue(undefined);
  spyOn(review, 'requestTournamentReviewTournamentCorrection').mockResolvedValue([]);
  await repairTournamentSetupIssue(season, issueId);
  expect(rebuild).toHaveBeenCalledTimes(1);
});

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
  expect(unfinished[0]!.issueId).toBe(attached);
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
