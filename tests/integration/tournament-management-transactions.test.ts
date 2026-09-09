import { assertIntegrationEnv } from './helpers/env-guard';
assertIntegrationEnv();
import { afterAll, afterEach, expect, test, spyOn, mock } from 'bun:test';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { databaseTransactionStorage, getDbClient } from '../../src/db/singleton';
import {
  createTournamentManagementService,
  type TournamentManagementRepository,
} from '../../src/services/tournament-management.service';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
afterAll(async () => {
  await observer.end();
});

test('official resume queue observes committed intent outside the lifecycle transaction', async () => {
  const marker = `integration:management-resume:${randomUUID()}`;
  const tournament = {
    id: 995902,
    adminEntryId: 123,
    state: 'inactive',
    rosterMode: 'official_sync',
    updatedAt: 'fixture-version',
  };
  const repository = {
    findById: async () => tournament,
  } as unknown as TournamentManagementRepository;
  const service = createTournamentManagementService(
    repository,
    {
      assertRosterBoundary: async () => undefined,
      findRosterReconcileJob: async () => null,
      infoRepository: { markSetupResult: async () => undefined },
      rosterRepository: {
        findById: async () => null,
        markResumeProcessing: async () => undefined,
        markResumeProcessingWithMarker: async () => {
          const db = await getDbClient();
          await db`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES(${marker},clock_timestamp())`;
          return marker;
        },
        markSyncPending: async () => 'retry-marker',
        markSyncFailed: async () => undefined,
      },
      enqueueRosterReconcile: async () => {
        expect(Boolean(databaseTransactionStorage.getStore())).toBe(false);
        const rows =
          await observer`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${marker}`;
        expect(rows).toHaveLength(1);
        return { id: 'fixture-job' } as never;
      },
    },
    async () => TEST_SEASON,
  );
  try {
    await service.setTournamentState(995902, { adminEntryId: 123, state: 'active' });
  } finally {
    await observer`DELETE FROM ops.mutation_scopes WHERE scope_key=${marker}`;
  }
});

afterEach(() => mock.restore());

for (const cleanupFails of [false, true]) {
  test(`delete commits before queue cleanup and remains successful when cleanup fails=${cleanupFails}`, async () => {
    const { tournamentManagementService } = await import(
      '../../src/services/tournament-management.service'
    );
    const { tournamentManagementRepository } = await import(
      '../../src/repositories/tournament-management'
    );
    const { seasonRepository } = await import('../../src/repositories/seasons');
    const setup = await import('../../src/jobs/tournament-setup.jobs');
    const roster = await import('../../src/jobs/tournament-sync.jobs');
    const repair = await import('../../src/jobs/tournament-repair.jobs');
    const selection = await import('../../src/services/tournament-selection-stats.service');
    const views = await import('../../src/services/tournament-materialized-views.service');
    const marker = `integration:management-delete:${randomUUID()}`;
    const tournament = { id: 995903, name: 'Fixture', adminEntryId: 123 } as never;
    spyOn(seasonRepository, 'findCurrent').mockResolvedValue(TEST_SEASON as never);
    spyOn(tournamentManagementRepository, 'findById').mockResolvedValue(tournament);
    spyOn(tournamentManagementRepository, 'deleteOwned').mockImplementation(async () => {
      const db = await getDbClient();
      await db`INSERT INTO ops.mutation_scopes(scope_key,last_used_at) VALUES(${marker},clock_timestamp())`;
      return { status: 'deleted', tournament };
    });
    let cleanups = 0;
    const cleanup = async () => {
      expect(Boolean(databaseTransactionStorage.getStore())).toBe(false);
      expect(
        await observer`SELECT scope_key FROM ops.mutation_scopes WHERE scope_key=${marker}`,
      ).toHaveLength(1);
      cleanups += 1;
      if (cleanupFails) throw new Error('queue unavailable');
      return 1;
    };
    spyOn(setup, 'cancelWaitingTournamentSetupJobs').mockImplementation(cleanup);
    spyOn(roster, 'cancelWaitingTournamentRosterReconcileJobs').mockImplementation(cleanup);
    spyOn(repair, 'cancelTournamentRepairJobs').mockImplementation(cleanup);
    spyOn(selection, 'refreshTournamentSelectionStatsMaterializedView').mockResolvedValue(
      undefined as never,
    );
    spyOn(views, 'refreshTournamentEntryEventSummariesMaterializedView').mockResolvedValue(
      undefined as never,
    );
    try {
      await tournamentManagementService.deleteTournament(995903, { adminEntryId: 123 });
      expect(cleanups).toBe(3);
    } finally {
      await observer`DELETE FROM ops.mutation_scopes WHERE scope_key=${marker}`;
    }
  });
}

test('roster retry intent creates a committed marker that fences old queue claims', async () => {
  const { explicitSeasonRef } = await import('../../src/domain/fpl-season');
  const { tournamentRosterRepository } = await import('../../src/repositories/tournament-roster');
  const { withMutationScopes } = await import('../../src/utils/mutation-scopes');
  const { tournamentSetupLifecycleScope } = await import('../../src/domain/mutation-scope');
  const season = explicitSeasonRef('9899');
  const id = 995908;
  const scope = tournamentSetupLifecycleScope(id);
  try {
    await observer`INSERT INTO fpl.seasons(season_id,season_code,display_name,start_year,end_year,lifecycle_state)
      VALUES(${season.seasonId},${season.seasonCode},'Roster retry intent fixture',2098,2099,'reference_only')`;
    await observer`INSERT INTO competition.entries(season_id,entry_id,entry_name,player_name) VALUES(${season.seasonId},${id},'Fixture','Fixture')`;
    await observer`INSERT INTO competition.tournaments(season_id,tournament_id,name,creator,admin_entry_id,league_id,league_type,total_team_num,tournament_mode,group_mode,group_auto_averages,state,roster_mode,roster_sync_status,setup_status)
      VALUES(${season.seasonId},${id},'Retry intent fixture','integration-test',${id},${id},'classic',2,'normal','no_group',false,'active','official_sync','failed','ready')`;
    const old = await tournamentRosterRepository.findById(season, id);
    const marker = await withMutationScopes(
      { queueName: 'tournament-management', jobName: 'retry-intent-fixture', scopes: [scope] },
      async () => {
        const marker = await tournamentRosterRepository.markSyncPending(season, id);
        const [beforeCommit] =
          await observer`SELECT roster_sync_status FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
        expect(beforeCommit!.roster_sync_status).toBe('failed');
        return marker;
      },
    );
    const pending = await tournamentRosterRepository.findById(season, id);
    expect(pending!.rosterSyncStatus).toBe('pending');
    expect(pending!.setupProgressUpdatedAt).toBe(marker);
    expect(pending!.executionId).not.toBeNull();
    expect(pending!.setupStatus).toBe('ready');
    expect(
      await tournamentRosterRepository.markSyncProcessingIfMarker(
        season,
        id,
        old!.setupProgressUpdatedAt,
      ),
    ).toBe(false);
    expect(await tournamentRosterRepository.markSyncProcessingIfMarker(season, id, marker)).toBe(
      true,
    );
    expect(
      await tournamentRosterRepository.markSyncFailedIfOwned(
        season,
        id,
        pending!,
        'late queue error',
      ),
    ).toBe(false);
  } finally {
    await observer`DELETE FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
    await observer`DELETE FROM competition.entries WHERE season_id=${season.seasonId} AND entry_id=${id}`;
    await observer`DELETE FROM fpl.seasons WHERE season_id=${season.seasonId}`;
    await observer`DELETE FROM ops.mutation_scopes WHERE scope_key=${scope}`;
  }
});

test('scheduled roster recovery includes an inactive pending retry marker', async () => {
  const { explicitSeasonRef } = await import('../../src/domain/fpl-season');
  const { tournamentRosterRepository } = await import('../../src/repositories/tournament-roster');
  const season = explicitSeasonRef('9798');
  const id = 995909;
  try {
    await observer`INSERT INTO fpl.seasons(season_id,season_code,display_name,start_year,end_year,lifecycle_state)
      VALUES(${season.seasonId},${season.seasonCode},'Inactive roster recovery fixture',2097,2098,'reference_only')`;
    await observer`INSERT INTO competition.entries(season_id,entry_id,entry_name,player_name) VALUES(${season.seasonId},${id},'Fixture','Fixture')`;
    await observer`INSERT INTO competition.tournaments(season_id,tournament_id,name,creator,admin_entry_id,league_id,league_type,total_team_num,tournament_mode,group_mode,group_auto_averages,state,roster_mode,roster_sync_status,roster_sync_execution_id,setup_progress_updated_at,setup_status)
      VALUES(${season.seasonId},${id},'Inactive roster recovery fixture','integration-test',${id},${id},'classic',2,'normal','no_group',false,'inactive','official_sync','pending',${randomUUID()},clock_timestamp(),'ready')`;
    const candidates =
      await tournamentRosterRepository.findOfficialSyncReconciliationCandidates(season);
    expect(candidates.map((candidate) => candidate.id)).toContain(id);
    expect(candidates.find((candidate) => candidate.id === id)).toMatchObject({
      state: 'inactive',
      rosterSyncStatus: 'pending',
    });
  } finally {
    await observer`DELETE FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
    await observer`DELETE FROM competition.entries WHERE season_id=${season.seasonId} AND entry_id=${id}`;
    await observer`DELETE FROM fpl.seasons WHERE season_id=${season.seasonId}`;
  }
});

test('scheduled roster recovery excludes an inactive mode opt-in without a retry marker', async () => {
  const { explicitSeasonRef } = await import('../../src/domain/fpl-season');
  const { tournamentRosterRepository } = await import('../../src/repositories/tournament-roster');
  const { tournamentManagementRepository } = await import(
    '../../src/repositories/tournament-management'
  );
  const season = explicitSeasonRef('9697');
  const id = 995910;
  try {
    await observer`INSERT INTO fpl.seasons(season_id,season_code,display_name,start_year,end_year,lifecycle_state)
      VALUES(${season.seasonId},${season.seasonCode},'Inactive roster opt-in fixture',2096,2097,'reference_only')`;
    await observer`INSERT INTO competition.entries(season_id,entry_id,entry_name,player_name) VALUES(${season.seasonId},${id},'Fixture','Fixture')`;
    await observer`INSERT INTO competition.tournaments(season_id,tournament_id,name,creator,admin_entry_id,league_id,league_type,total_team_num,tournament_mode,group_mode,group_auto_averages,state,roster_mode,roster_sync_status,roster_sync_execution_id,setup_progress_updated_at,setup_status)
      VALUES(${season.seasonId},${id},'Inactive roster opt-in fixture','integration-test',${id},${id},'classic',2,'normal','no_group',false,'inactive','snapshot',NULL,${randomUUID()},clock_timestamp(),'ready')`;
    await tournamentManagementRepository.updateRosterModeOwned(season, id, id, 'official_sync');
    const markerState = await observer<
      Array<{ executionId: string | null; marker: string | null }>
    >`
      SELECT roster_sync_execution_id::text AS "executionId", setup_progress_updated_at::text AS marker
      FROM competition.tournaments
      WHERE season_id=${season.seasonId} AND tournament_id=${id}
    `;
    expect(markerState[0]).toEqual({ executionId: null, marker: null });
    const candidates =
      await tournamentRosterRepository.findOfficialSyncReconciliationCandidates(season);
    expect(candidates.map((candidate) => candidate.id)).not.toContain(id);
  } finally {
    await observer`DELETE FROM competition.tournaments WHERE season_id=${season.seasonId} AND tournament_id=${id}`;
    await observer`DELETE FROM competition.entries WHERE season_id=${season.seasonId} AND entry_id=${id}`;
    await observer`DELETE FROM fpl.seasons WHERE season_id=${season.seasonId}`;
  }
});
