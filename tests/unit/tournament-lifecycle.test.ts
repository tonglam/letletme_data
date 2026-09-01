import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { diffTournamentRoster } from '../../src/domain/tournament';
import { isTournamentNameConflict } from '../../src/repositories/tournament-infos';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { tournamentRosterRepository } from '../../src/repositories/tournament-roster';
import { logger } from '../../src/utils/logger';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

afterEach(() => {
  mock.restore();
});

describe('tournament lifecycle invariants', () => {
  test('does not reset readiness when a manual retry finds an active setup job', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    const { decideExistingSetupJobAction } = await import('../../src/jobs/tournament-setup.jobs');

    expect(
      decideExistingSetupJobAction('active', {
        forceNew: true,
        prepareEnqueue: async () => undefined,
      }),
    ).toBe('reject');
    expect(
      decideExistingSetupJobAction('active', {
        forceNew: true,
      }),
    ).toBe('reject');
    expect(
      decideExistingSetupJobAction(
        'active',
        {
          forceNew: true,
          ensureSuccessorOnActive: true,
        },
        'settling',
      ),
    ).toBe('enqueue_successor');
    expect(
      decideExistingSetupJobAction(
        'active',
        { forceNew: true, ensureSuccessorOnActive: true },
        'waiting_for_lifecycle',
      ),
    ).toBe('reuse');
    expect(
      decideExistingSetupJobAction('unknown', {
        forceNew: true,
      }),
    ).toBe('enqueue_base');
    expect(
      decideExistingSetupJobAction('waiting', {
        forceNew: true,
        prepareEnqueue: async () => undefined,
      }),
    ).toBe('remove');
  });

  test('reserves one stable setup successor slot per tournament', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    const { getTournamentSetupJobIds, decideExistingSetupSuccessorAction } = await import(
      '../../src/jobs/tournament-setup.jobs'
    );

    expect(getTournamentSetupJobIds(TEST_SEASON, 321)).toEqual({
      baseJobId: 'tournament-setup-2627-321',
      successorJobId: 'tournament-setup-2627-321-successor',
    });
    expect(decideExistingSetupSuccessorAction('waiting')).toBe('reuse');
    expect(decideExistingSetupSuccessorAction('active')).toBe('reuse');
    expect(decideExistingSetupSuccessorAction('completed')).toBe('remove');
    expect(decideExistingSetupSuccessorAction('failed')).toBe('remove');
    expect(decideExistingSetupSuccessorAction('unknown')).toBe('enqueue');
    expect(
      decideExistingSetupSuccessorAction('active', 'settling', {
        forceNew: true,
        ensureSuccessorOnActive: true,
      }),
    ).toBe('enqueue');
    expect(decideExistingSetupSuccessorAction('active', 'settling', { forceNew: true })).toBe(
      'reject',
    );
    expect(
      decideExistingSetupSuccessorAction('active', 'waiting_for_lifecycle', {
        forceNew: true,
        ensureSuccessorOnActive: true,
      }),
    ).toBe('reuse');
  });

  test('treats skipped structure units as a failed cascade slot', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    const { assertTournamentStructureSyncComplete } = await import(
      '../../src/workers/tournament-sync.worker'
    );

    expect(() =>
      assertTournamentStructureSyncComplete({ skipped: 0 }, 38, 'tournament-points-race'),
    ).not.toThrow();
    expect(() =>
      assertTournamentStructureSyncComplete({ skipped: 2 }, 38, 'tournament-knockout'),
    ).toThrow('tournament-knockout skipped 2 required unit(s) for event 38');
  });

  test('blocks standings when failed entry snapshots cannot prove the active season', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    const { classifyEntrySnapshotFailures } = await import(
      '../../src/services/tournament-backfill.service'
    );

    expect(classifyEntrySnapshotFailures([101, 102, 103], new Set([101, 103]))).toEqual([
      {
        scope: 'entry-info',
        message: 'Current-season entry snapshot remains unproven for 2 entries',
        failedEntries: [101, 103],
        blocksStandings: true,
      },
      {
        scope: 'entry-info',
        message: 'Failed to refresh detailed entry info for 1 entry',
        failedEntries: [102],
      },
    ]);
  });

  test('normalizes audit causes into stable, capability-scoped issue codes', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    const { tournamentSetupIssueFromAuditMessage } = await import(
      '../../src/services/tournament-backfill.service'
    );

    expect(
      tournamentSetupIssueFromAuditMessage('missing entry_league_infos for 2 entries', {
        affectedEntryIds: [300, 200, 300],
      }),
    ).toMatchObject({
      code: 'ENTRY_PROFILE_INCOMPLETE',
      category: 'profiles',
      severity: 'warning',
      failedEntries: [300, 200, 300],
    });
    expect(
      tournamentSetupIssueFromAuditMessage('missing entry_event_results rows for event 7', {
        affectedEntryIds: [101, 102],
      }),
    ).toMatchObject({
      code: 'TOURNAMENT_RESULTS_INCOMPLETE',
      category: 'results',
      eventId: 7,
      severity: 'warning',
    });
    expect(
      tournamentSetupIssueFromAuditMessage(
        'tournament_groups count 3 does not match participant count 4',
      ),
    ).toMatchObject({
      code: 'STRUCTURE_INTEGRITY_FAILED',
      severity: 'blocking',
    });
  });

  test('resumes before terminalizing a post-publication warning', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    const maintenanceJobs = await import('../../src/jobs/maintenance.jobs');
    const enqueueReviewSpy = spyOn(maintenanceJobs, 'enqueueTournamentReview').mockResolvedValue(
      {} as never,
    );
    const { finalizePublishedTournamentSetup } = await import(
      '../../src/services/tournament-setup.service'
    );
    const calls: string[] = [];
    spyOn(tournamentRosterRepository, 'markReadyAndResume').mockImplementation(async () => {
      calls.push('resume');
    });
    spyOn(tournamentInfoRepository, 'markSetupResult').mockImplementation(async () => {
      calls.push('ready-with-warning');
    });

    await finalizePublishedTournamentSetup(TEST_SEASON, 900_122, 'enrichment failed', 1);

    expect(calls).toEqual(['resume', 'ready-with-warning']);
    expect(tournamentInfoRepository.markSetupResult).toHaveBeenCalledWith(
      TEST_SEASON,
      900_122,
      'ready',
      null,
      1,
    );
    expect(enqueueReviewSpy).toHaveBeenCalledWith(TEST_SEASON, 'api', {
      tournamentId: 900_122,
      attempts: 3,
      backoffDelayMs: 60_000,
      deduplicationId: `tournament-review-bootstrap-${TEST_SEASON.seasonCode}-900122`,
    });
  });

  test('returns exact roster diffs for joins, departures, simultaneous changes, and duplicates', () => {
    expect(diffTournamentRoster([1, 2], [1, 2])).toEqual({
      addedEntryIds: [],
      removedEntryIds: [],
    });
    expect(diffTournamentRoster([1, 2], [1, 2, 3])).toEqual({
      addedEntryIds: [3],
      removedEntryIds: [],
    });
    expect(diffTournamentRoster([1, 2], [2])).toEqual({
      addedEntryIds: [],
      removedEntryIds: [1],
    });
    expect(diffTournamentRoster([1, 2, 2, 3], [2, 3, 3, 4])).toEqual({
      addedEntryIds: [4],
      removedEntryIds: [1],
    });
  });

  test('maps only the database tournament-name race to a public conflict', () => {
    expect(isTournamentNameConflict({ code: '23505', constraint: 'tournaments_name_key' })).toBe(
      true,
    );
    expect(
      isTournamentNameConflict({
        cause: { code: '23505', constraint_name: 'tournaments_name_key' },
      }),
    ).toBe(true);
    expect(isTournamentNameConflict({ code: '23505', constraint: 'another_unique_index' })).toBe(
      false,
    );
    expect(isTournamentNameConflict(new Error('connection failed'))).toBe(false);
  });

  test('emits one setup-attempt report when initial state lookup fails', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    const { setupTournamentStructure } = await import(
      '../../src/services/tournament-setup.service'
    );
    spyOn(tournamentInfoRepository, 'findSetupStatus').mockRejectedValue(
      Object.assign(new Error('private database detail'), { code: 'SETUP_STATUS_READ_FAILED' }),
    );
    spyOn(tournamentInfoRepository, 'findSetupConfig').mockResolvedValue(null);
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);

    await expect(setupTournamentStructure(TEST_SEASON, 900_123)).rejects.toThrow(
      'private database detail',
    );

    const reports = infoSpy.mock.calls
      .map(([payload]) => payload as unknown as Record<string, unknown>)
      .filter((payload) => payload.event === 'tournament_setup_attempt');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: 'failed_before_standings',
      tournamentId: 900_123,
      failureCode: 'SETUP_STATUS_READ_FAILED',
    });
    expect(JSON.stringify(reports[0])).not.toContain('private database detail');
  });

  test('treats resume failure before this attempt publishes standings as critical', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    const { setupTournamentStructure } = await import(
      '../../src/services/tournament-setup.service'
    );
    const originalDatabaseUrl = process.env.DATABASE_URL;
    spyOn(tournamentInfoRepository, 'findSetupStatus').mockResolvedValue({
      tournamentId: 900_124,
      setupStatus: 'processing',
      setupPhase: 'syncing_entries',
      setupCompletedUnits: 0,
      setupTotalUnits: 1,
      setupProgressUpdatedAt: null,
      standingsReadyAt: '2026-01-01T00:00:00.000Z',
      setupWarningCount: 0,
      setupStartedAt: '2026-01-01T00:00:00.000Z',
      setupFinishedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);
    spyOn(tournamentInfoRepository, 'findSetupConfig').mockResolvedValue({ id: 900_124 } as never);
    spyOn(tournamentInfoRepository, 'markSetupProcessing').mockRejectedValue(
      new Error('resume preparation failed'),
    );
    const resultSpy = spyOn(tournamentInfoRepository, 'markSetupResult').mockResolvedValue(
      undefined as never,
    );
    process.env.DATABASE_URL = '';

    try {
      await expect(setupTournamentStructure(TEST_SEASON, 900_124)).rejects.toThrow(
        'resume preparation failed',
      );
      expect(resultSpy).not.toHaveBeenCalled();
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });
});
