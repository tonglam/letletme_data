import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { diffTournamentRoster } from '../../src/domain/tournament';
import { isTournamentNameConflict } from '../../src/repositories/tournament-infos';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { tournamentRosterRepository } from '../../src/repositories/tournament-roster';
import { logger } from '../../src/utils/logger';

afterEach(() => {
  mock.restore();
});

describe('tournament lifecycle invariants', () => {
  test('does not reset readiness when a manual retry finds an active setup job', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    process.env.REDIS_HOST ??= '127.0.0.1';
    process.env.REDIS_PORT ??= '6379';
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
      decideExistingSetupJobAction('active', {
        forceNew: true,
        ensureSuccessorOnActive: true,
      }),
    ).toBe('enqueue_successor');
    expect(
      decideExistingSetupJobAction('waiting', {
        forceNew: true,
        prepareEnqueue: async () => undefined,
      }),
    ).toBe('remove');
  });

  test('blocks standings when failed entry snapshots cannot prove the active season', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    process.env.REDIS_HOST ??= '127.0.0.1';
    process.env.REDIS_PORT ??= '6379';
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

  test('resumes before terminalizing a post-publication warning', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    process.env.REDIS_HOST ??= '127.0.0.1';
    process.env.REDIS_PORT ??= '6379';
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

    await finalizePublishedTournamentSetup(900_122, 'enrichment failed', 1);

    expect(calls).toEqual(['resume', 'ready-with-warning']);
    expect(tournamentInfoRepository.markSetupResult).toHaveBeenCalledWith(
      900_122,
      'ready',
      'enrichment failed',
      1,
    );
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
    expect(isTournamentNameConflict({ code: '23505', constraint: 'unique_tournament_name' })).toBe(
      true,
    );
    expect(isTournamentNameConflict({ code: '23505', constraint: 'another_unique_index' })).toBe(
      false,
    );
    expect(isTournamentNameConflict(new Error('connection failed'))).toBe(false);
  });

  test('emits one setup-attempt report when initial state lookup fails', async () => {
    process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';
    process.env.REDIS_HOST ??= '127.0.0.1';
    process.env.REDIS_PORT ??= '6379';
    const { setupTournamentStructure } = await import(
      '../../src/services/tournament-setup.service'
    );
    spyOn(tournamentInfoRepository, 'findSetupStatus').mockRejectedValue(
      Object.assign(new Error('private database detail'), { code: 'SETUP_STATUS_READ_FAILED' }),
    );
    spyOn(tournamentInfoRepository, 'findSetupConfig').mockResolvedValue(null);
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);

    await expect(setupTournamentStructure(900_123)).rejects.toThrow('private database detail');

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
    process.env.REDIS_HOST ??= '127.0.0.1';
    process.env.REDIS_PORT ??= '6379';
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
      await expect(setupTournamentStructure(900_124)).rejects.toThrow('resume preparation failed');
      expect(resultSpy).toHaveBeenCalledWith(900_124, 'failed', 'resume preparation failed', 0);
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });
});
