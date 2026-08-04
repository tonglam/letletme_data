import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { diffTournamentRoster } from '../../src/domain/tournament';
import { isTournamentNameConflict } from '../../src/repositories/tournament-infos';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { logger } from '../../src/utils/logger';

afterEach(() => {
  mock.restore();
});

describe('tournament lifecycle invariants', () => {
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
});
