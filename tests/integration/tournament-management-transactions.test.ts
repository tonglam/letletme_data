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
