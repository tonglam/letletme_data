import { describe, expect, test } from 'bun:test';

import type { TournamentManagementRecord } from '../../src/repositories/tournament-management';
import {
  createTournamentManagementService as createServiceUnderTest,
  requestSnapshotTournamentResume,
  type TournamentManagementRepository,
} from '../../src/services/tournament-management.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../../src/utils/errors';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const tournament: TournamentManagementRecord = {
  id: 42,
  name: 'Original Cup',
  creator: 'Manager',
  adminEntryId: 123,
  totalTeamNum: 8,
  leagueType: 'classic',
  groupMode: 'points_races',
  groupNum: 1,
  knockoutMode: 'no_knockout',
  rosterMode: 'snapshot',
  state: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function createRepository(
  overrides: Partial<TournamentManagementRepository> = {},
): TournamentManagementRepository {
  return {
    findById: async () => tournament,
    checkNameExistsExcluding: async () => false,
    updateNameOwned: async (_season, _id, _adminEntryId, name) => ({ ...tournament, name }),
    updateStateOwned: async (_season, _id, _adminEntryId, state) => ({ ...tournament, state }),
    updateRosterModeOwned: async (_season, _id, _adminEntryId, rosterMode) => ({
      ...tournament,
      rosterMode,
    }),
    deleteOwned: async () => ({ status: 'deleted', tournament }),
    ...overrides,
  };
}

function createTestService(
  repository: TournamentManagementRepository,
  lifecycle: Parameters<typeof createServiceUnderTest>[1] = {},
) {
  return createServiceUnderTest(
    repository,
    {
      withMutationScopes: async (_input, operation) => operation(),
      findRosterReconcileJob: async () => null,
      findSetupJob: async () => null,
      assertRosterBoundary: async () => undefined,
      rosterRepository: {
        findById: async () => null,
        markResumeProcessingWithMarker: async () => 'resume-marker',
        markResumeProcessing: async () => undefined,
        markSyncFailed: async () => undefined,
      },
      infoRepository: { markSetupResult: async () => undefined },
      enqueueRosterReconcile: async () => ({ id: 'roster-job' }) as never,
      enqueueSnapshotSetup: async (_season, tournamentId, _source, options) => {
        await options.prepareEnqueue();
        return { id: `setup-${tournamentId}` };
      },
      requeueSetup: async (_season, tournamentId) => ({ id: `setup-${tournamentId}` }),
      ...lifecycle,
    },
    async () => TEST_SEASON,
  );
}

describe('tournament management service', () => {
  test('does not publish resume markers when an active setup rejects the replacement', async () => {
    const calls: string[] = [];
    const activeError = new ConflictError(
      'Tournament setup is already running.',
      'TOURNAMENT_SETUP_IN_PROGRESS',
    );

    await expect(
      requestSnapshotTournamentResume(42, {
        enqueue: async () => {
          calls.push('enqueue-rejected');
          throw activeError;
        },
        markResumeProcessing: async () => {
          calls.push('mark-pending');
        },
        markRosterFailed: async () => {
          calls.push('mark-roster-failed');
        },
        markSetupFailed: async () => {
          calls.push('mark-setup-failed');
        },
      }),
    ).rejects.toBe(activeError);

    expect(calls).toEqual(['enqueue-rejected']);
  });

  test('marks only a prepared resume failed when queue publication fails', async () => {
    const calls: string[] = [];
    const enqueueError = new Error('queue unavailable');

    await expect(
      requestSnapshotTournamentResume(42, {
        enqueue: async (_id, _source, options) => {
          await options.prepareEnqueue();
          calls.push('enqueue-failed');
          throw enqueueError;
        },
        markResumeProcessing: async () => {
          calls.push('mark-pending');
        },
        markRosterFailed: async () => {
          calls.push('mark-roster-failed');
        },
        markSetupFailed: async () => {
          calls.push('mark-setup-failed');
        },
      }),
    ).rejects.toBe(enqueueError);

    expect(calls).toEqual([
      'mark-pending',
      'enqueue-failed',
      'mark-roster-failed',
      'mark-setup-failed',
    ]);
  });

  test('updates only an administrator-owned tournament and trims the name', async () => {
    let updatedName = '';
    const calls: string[] = [];
    const service = createTestService(
      createRepository({
        updateNameOwned: async (_season, _id, _adminEntryId, name) => {
          updatedName = name;
          return { ...tournament, name };
        },
      }),
      {
        refreshViews: async () => {
          calls.push('refresh-views');
        },
      },
    );

    const updated = await service.updateTournament(42, {
      name: '  Renamed Cup  ',
      adminEntryId: 123,
    });

    expect(updated.name).toBe('Renamed Cup');
    expect(updatedName).toBe('Renamed Cup');
    expect(calls).toEqual([]);
  });

  test('rejects updates from a different FPL entry', async () => {
    const service = createTestService(createRepository());
    await expect(
      service.updateTournament(42, { name: 'Renamed Cup', adminEntryId: 999 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('lets a platform administrator update another owner while preserving ownership', async () => {
    const persistedOwnerEntryIds: number[] = [];
    const service = createTestService(
      createRepository({
        updateNameOwned: async (_season, _id, adminEntryId, name) => {
          persistedOwnerEntryIds.push(adminEntryId);
          return { ...tournament, name };
        },
      }),
    );

    const updated = await service.updateTournament(42, {
      name: 'Platform Managed Cup',
      adminEntryId: 6953,
      platformAdmin: true,
    });

    expect(updated.name).toBe('Platform Managed Cup');
    expect(persistedOwnerEntryIds).toEqual([tournament.adminEntryId]);
    expect(updated.adminEntryId).toBe(tournament.adminEntryId);
  });

  test('returns a same-name retry without refreshing unrelated reporting views', async () => {
    const calls: string[] = [];
    const service = createTestService(createRepository(), {
      refreshViews: async () => {
        calls.push('refresh-views');
      },
    });

    const unchanged = await service.updateTournament(42, {
      name: tournament.name,
      adminEntryId: tournament.adminEntryId,
    });

    expect(unchanged).toEqual(tournament);
    expect(calls).toEqual([]);
  });

  test('rejects a duplicate tournament name', async () => {
    const service = createTestService(
      createRepository({ checkNameExistsExcluding: async () => true }),
    );
    await expect(
      service.updateTournament(42, { name: 'Existing Cup', adminEntryId: 123 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('returns not found when the tournament does not exist', async () => {
    const service = createTestService(createRepository({ findById: async () => null }));
    await expect(
      service.updateTournament(42, { name: 'Renamed Cup', adminEntryId: 123 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('does not enable official roster synchronization after a tournament finishes', async () => {
    const service = createTestService(
      createRepository({ findById: async () => ({ ...tournament, state: 'finished' }) }),
    );
    await expect(
      service.setRosterMode(42, { adminEntryId: 123, rosterMode: 'official_sync' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test('does not persist official-sync opt-in during an active gameweek', async () => {
    let updates = 0;
    const service = createTestService(
      createRepository({
        updateRosterModeOwned: async (_season, _id, _adminEntryId, rosterMode) => {
          updates += 1;
          return { ...tournament, rosterMode };
        },
      }),
      {
        assertRosterBoundary: async () => {
          throw Object.assign(new Error('frozen'), { code: 'TOURNAMENT_ROSTER_FROZEN' });
        },
      },
    );

    await expect(
      service.setRosterMode(42, { adminEntryId: 123, rosterMode: 'official_sync' }),
    ).rejects.toMatchObject({ code: 'TOURNAMENT_ROSTER_FROZEN' });
    expect(updates).toBe(0);
  });

  test('re-applies an inactive state so a newer pause can withdraw a pending resume', async () => {
    let updates = 0;
    const service = createTestService(
      createRepository({
        findById: async () => ({ ...tournament, state: 'inactive' }),
        updateStateOwned: async (_season, _id, _adminEntryId, state) => {
          updates += 1;
          return { ...tournament, state };
        },
      }),
    );

    const paused = await service.setTournamentState(42, {
      adminEntryId: 123,
      state: 'inactive',
    });

    expect(paused.state).toBe('inactive');
    expect(updates).toBe(1);
  });

  test('deletes an owned tournament', async () => {
    const calls: string[] = [];
    const service = createTestService(
      createRepository({
        deleteOwned: async () => {
          calls.push('delete');
          return { status: 'deleted', tournament };
        },
      }),
      {
        refreshViews: async () => {
          calls.push('refresh-views');
        },
      },
    );
    const deleted = await service.deleteTournament(42, { adminEntryId: 123 });
    expect(deleted).toEqual(tournament);
    expect(calls).toEqual(['delete', 'refresh-views']);
  });

  test('keeps DELETE successful when committed Redis invalidation is pending', async () => {
    const calls: string[] = [];
    const service = createTestService(
      createRepository({
        deleteOwned: async () => ({
          status: 'deleted',
          tournament,
          invalidationOutboxIds: ['00000000-0000-4000-8000-000000000319'],
        }),
      }),
      {
        dispatchInvalidations: async (options) => {
          calls.push(`dispatch:${options.outboxIds?.length ?? 0}`);
          return { claimed: 1, delivered: 0, superseded: 0, failed: 1, remaining: 1 };
        },
        refreshViews: async () => {
          calls.push('refresh-views');
        },
      },
    );

    await expect(service.deleteTournament(42, { adminEntryId: 123 })).resolves.toEqual(tournament);
    expect(calls).toEqual(['dispatch:1', 'refresh-views']);
  });

  test('reconciles pending invalidation receipts when DELETE is retried', async () => {
    const calls: string[] = [];
    const service = createTestService(createRepository({ findById: async () => null }), {
      reconcileInvalidations: async (_season, tournamentId) => {
        calls.push(`reconcile:${tournamentId}`);
        return { claimed: 1, delivered: 1, superseded: 0, failed: 0, remaining: 0 };
      },
      repairDeletedViews: async (tournamentId) => {
        calls.push(`repair-views:${tournamentId}`);
        return true;
      },
    });

    await expect(
      service.deleteTournament(42, { adminEntryId: tournament.adminEntryId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toEqual(['reconcile:42', 'repair-views:42']);
  });

  test('rejects deletion from a different FPL entry', async () => {
    const service = createTestService(
      createRepository({ deleteOwned: async () => ({ status: 'forbidden' }) }),
    );
    await expect(service.deleteTournament(42, { adminEntryId: 999 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test('lets a platform administrator delete through the canonical owner predicate', async () => {
    const persistedOwnerEntryIds: number[] = [];
    const service = createTestService(
      createRepository({
        deleteOwned: async (_season, _id, adminEntryId) => {
          persistedOwnerEntryIds.push(adminEntryId);
          return { status: 'deleted', tournament };
        },
      }),
    );

    await service.deleteTournament(42, {
      adminEntryId: 6953,
      platformAdmin: true,
    });

    expect(persistedOwnerEntryIds).toEqual([tournament.adminEntryId]);
  });

  test('does not turn a committed deletion into a false failure when view refresh is pending', async () => {
    const calls: string[] = [];
    const refreshError = new Error('refresh failed');
    const service = createTestService(createRepository(), {
      refreshViews: async () => {
        calls.push('refresh-views');
        throw refreshError;
      },
      repairDeletedViews: async () => {
        calls.push('repair-views');
        throw new Error('repair still pending');
      },
    });

    await expect(service.deleteTournament(42, { adminEntryId: 123 })).resolves.toEqual(tournament);
    expect(calls).toEqual(['refresh-views', 'repair-views']);
  });

  test('repairs a stale deleted snapshot when an owner retries after refresh failure', async () => {
    const calls: string[] = [];
    const service = createTestService(createRepository({ findById: async () => null }), {
      repairDeletedViews: async (tournamentId) => {
        calls.push(`repair-views:${tournamentId}`);
        return true;
      },
    });

    await expect(
      service.deleteTournament(42, { adminEntryId: tournament.adminEntryId }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toEqual(['repair-views:42']);
  });

  test('rejects finished resume and returns an already-active tournament unchanged', async () => {
    const activeService = createTestService(createRepository());
    await expect(
      activeService.setTournamentState(42, { adminEntryId: 123, state: 'active' }),
    ).resolves.toEqual(tournament);

    const finishedService = createTestService(
      createRepository({ findById: async () => ({ ...tournament, state: 'finished' }) }),
    );
    await expect(
      finishedService.setTournamentState(42, { adminEntryId: 123, state: 'active' }),
    ).rejects.toMatchObject({ code: 'TOURNAMENT_FINISHED' });
  });

  test('settles a failed official resume only when its queue job still exists', async () => {
    let settleResume: boolean | undefined;
    const failedResume = {
      ...tournament,
      state: 'inactive' as const,
      rosterMode: 'official_sync' as const,
      rosterSyncStatus: 'failed' as const,
      setupStatus: 'failed' as const,
      setupPhase: 'failed' as const,
      setupError: 'queue response lost',
      setupProgressUpdatedAt: '2026-08-28T00:00:00.000Z',
    };
    const service = createTestService(
      createRepository({
        findById: async () => failedResume,
        updateStateOwned: async (_season, _id, _owner, state, options) => {
          settleResume = options?.settleResume;
          return { ...failedResume, state };
        },
      }),
      { findRosterReconcileJob: async () => ({ id: 'existing' }) as never },
    );

    await service.setTournamentState(42, { adminEntryId: 123, state: 'inactive' });
    expect(settleResume).toBe(true);
  });

  test('resumes snapshot and official-sync tournaments through injected queue ports', async () => {
    const calls: string[] = [];
    const snapshot = { ...tournament, state: 'inactive' as const };
    const snapshotService = createTestService(
      createRepository({ findById: async () => snapshot }),
      {
        enqueueSnapshotSetup: async (_season, id, _source, options) => {
          await options.prepareEnqueue();
          calls.push(`snapshot-enqueue:${id}`);
        },
        rosterRepository: {
          findById: async () => null,
          markResumeProcessingWithMarker: async () => 'unused',
          markResumeProcessing: async (_season, id) => {
            calls.push(`snapshot-marker:${id}`);
          },
          markSyncFailed: async () => undefined,
        },
      },
    );
    await snapshotService.setTournamentState(42, { adminEntryId: 123, state: 'active' });

    const official = {
      ...snapshot,
      rosterMode: 'official_sync' as const,
      rosterSyncStatus: 'ready' as const,
    };
    const officialService = createTestService(
      createRepository({ findById: async () => official }),
      {
        rosterRepository: {
          findById: async () => null,
          markResumeProcessingWithMarker: async () => 'marker-42',
          markResumeProcessing: async () => undefined,
          markSyncFailed: async () => undefined,
        },
        enqueueRosterReconcile: async (_season, id, _source, options) => {
          calls.push(`official-enqueue:${id}:${options?.resumeMarker}`);
          return { id: 'official-job' } as never;
        },
      },
    );
    await officialService.setTournamentState(42, { adminEntryId: 123, state: 'active' });

    expect(calls).toEqual([
      'snapshot-marker:42',
      'snapshot-enqueue:42',
      'official-enqueue:42:marker-42',
    ]);
  });

  test('keeps an ambiguously accepted official resume and fails a definitely lost one', async () => {
    const official = {
      ...tournament,
      state: 'inactive' as const,
      rosterMode: 'official_sync' as const,
      rosterSyncStatus: 'ready' as const,
    };
    const queueError = new Error('queue response lost');
    const acceptedService = createTestService(
      createRepository({ findById: async () => official }),
      {
        enqueueRosterReconcile: async () => {
          throw queueError;
        },
        findRosterReconcileJob: async () => ({ id: 'accepted' }) as never,
      },
    );
    await expect(
      acceptedService.setTournamentState(42, { adminEntryId: 123, state: 'active' }),
    ).resolves.toEqual(official);

    const failures: string[] = [];
    const rejectedService = createTestService(
      createRepository({ findById: async () => official }),
      {
        enqueueRosterReconcile: async () => {
          throw queueError;
        },
        rosterRepository: {
          findById: async () => null,
          markResumeProcessingWithMarker: async () => 'marker-42',
          markResumeProcessing: async () => undefined,
          markSyncFailed: async () => {
            failures.push('roster');
          },
        },
        infoRepository: {
          markSetupResult: async () => {
            failures.push('setup');
          },
        },
      },
    );
    await expect(
      rejectedService.setTournamentState(42, { adminEntryId: 123, state: 'active' }),
    ).rejects.toBe(queueError);
    expect(failures.sort()).toEqual(['roster', 'setup']);
  });

  test('rejects ineligible official sync and heals a missing pending reconcile job', async () => {
    const ineligibleService = createTestService(
      createRepository({ findById: async () => ({ ...tournament, groupNum: 2 }) }),
    );
    await expect(
      ineligibleService.setRosterMode(42, {
        adminEntryId: 123,
        rosterMode: 'official_sync',
      }),
    ).rejects.toMatchObject({ code: 'TOURNAMENT_ROSTER_MODE_INELIGIBLE' });

    let enqueued = 0;
    const pending = {
      ...tournament,
      rosterMode: 'official_sync' as const,
      rosterSyncStatus: 'pending' as const,
    };
    const pendingService = createTestService(createRepository({ findById: async () => pending }), {
      enqueueRosterReconcile: async () => {
        enqueued += 1;
        return { id: 'healed' } as never;
      },
    });
    await expect(
      pendingService.setRosterMode(42, {
        adminEntryId: 123,
        rosterMode: 'official_sync',
      }),
    ).resolves.toEqual(pending);
    expect(enqueued).toBe(1);
  });

  test('marks roster sync failed when an active official-sync enqueue fails', async () => {
    const queueError = new Error('queue unavailable');
    const failures: string[] = [];
    const service = createTestService(createRepository(), {
      enqueueRosterReconcile: async () => {
        throw queueError;
      },
      rosterRepository: {
        findById: async () => null,
        markResumeProcessingWithMarker: async () => 'unused',
        markResumeProcessing: async () => undefined,
        markSyncFailed: async (_season, id, message) => {
          failures.push(`${id}:${message}`);
        },
      },
    });

    await expect(
      service.setRosterMode(42, { adminEntryId: 123, rosterMode: 'official_sync' }),
    ).rejects.toBe(queueError);
    expect(failures).toEqual(['42:queue unavailable']);
  });

  test('retries setup unless an authoritative official resume is already pending', async () => {
    const pending = {
      ...tournament,
      state: 'inactive' as const,
      rosterMode: 'official_sync' as const,
      rosterSyncStatus: 'processing' as const,
      setupStatus: 'processing' as const,
      setupPhase: 'queued' as const,
      setupProgressUpdatedAt: '2026-08-28T00:00:00.000Z',
    };
    const blocked = createTestService(createRepository({ findById: async () => pending }), {
      findSetupJob: async () => ({ id: 'running' }) as never,
    });
    await expect(blocked.retrySetup(42, { adminEntryId: 123 })).rejects.toMatchObject({
      code: 'TOURNAMENT_RESUME_PENDING',
    });

    const retry = createTestService(createRepository());
    await expect(retry.retrySetup(42, { adminEntryId: 123 })).resolves.toEqual({
      id: 'setup-42',
    });
  });

  test('validates roster retries and returns the injected operation id', async () => {
    const snapshotService = createTestService(createRepository());
    await expect(snapshotService.retryRoster(42, { adminEntryId: 123 })).rejects.toMatchObject({
      code: 'TOURNAMENT_ROSTER_SNAPSHOT',
    });

    const official = {
      ...tournament,
      state: 'inactive' as const,
      rosterMode: 'official_sync' as const,
      rosterSyncStatus: 'failed' as const,
      setupStatus: 'ready' as const,
    };
    const service = createTestService(createRepository({ findById: async () => official }), {
      enqueueRosterReconcile: async () => ({ id: 'retry-42' }) as never,
    });
    await expect(service.retryRoster(42, { adminEntryId: 123 })).resolves.toEqual({
      tournamentId: 42,
      changed: false,
      queued: true,
      operationId: 'retry-42',
      status: 'pending',
    });
  });

  test('maps repository deletion races and keeps committed dispatch failures successful', async () => {
    const missing = createTestService(
      createRepository({ deleteOwned: async () => ({ status: 'not_found' }) }),
    );
    await expect(missing.deleteTournament(42, { adminEntryId: 123 })).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const forbidden = createTestService(
      createRepository({ deleteOwned: async () => ({ status: 'forbidden' }) }),
    );
    await expect(forbidden.deleteTournament(42, { adminEntryId: 123 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const committed = createTestService(
      createRepository({
        deleteOwned: async () => ({
          status: 'deleted',
          tournament,
          invalidationOutboxIds: ['00000000-0000-4000-8000-000000000001'],
        }),
      }),
      {
        dispatchInvalidations: async () => {
          throw new Error('Redis unavailable');
        },
      },
    );
    await expect(committed.deleteTournament(42, { adminEntryId: 123 })).resolves.toEqual(
      tournament,
    );
  });
});
