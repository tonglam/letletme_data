import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import postgres from 'postgres';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import { tournamentSetupLifecycleScope } from '../../src/domain/mutation-scope';
import { tournamentSetupIssueRepository } from '../../src/repositories/tournament-setup-issues';
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
  await sql`DELETE FROM competition.tournament_entries WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.tournament_setup_issues WHERE season_id=${season.seasonId}`;
  await sql`DELETE FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${tournamentId}`;
  await sql`DELETE FROM competition.entries WHERE season_id=${season.seasonId} AND entry_id=${tournamentId}`;
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
test('a newly observed issue rejects the old repair callback', async () => {
  const owner = await capture();
  await tournamentSetupIssueRepository.sync(season, tournamentId, [input]);
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
      () => tournamentSetupIssueRepository.sync(season, tournamentId, [input]),
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
  await tournamentSetupIssueRepository.sync(season, tournamentId, [input]);
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
  const correction = spyOn(
    review,
    'requestTournamentReviewTournamentCorrection',
  ).mockImplementation(async () => {
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
