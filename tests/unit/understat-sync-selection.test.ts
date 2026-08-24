import { describe, expect, test } from 'bun:test';

import type { UnderstatMatch, UnderstatTeam } from '../../src/domain/understat';
import {
  assertNoUnderstatMatchesDisappeared,
  assertUnderstatLeagueSnapshotComplete,
  changedUnderstatPlayerSeasonIds,
  changedUnderstatPlayerTeamIds,
  changedUnderstatTeamStatIds,
  mergeUnderstatTeamDetailIds,
  selectPlayerMatchIds,
  selectTeamDetailIds,
  withdrawnUnderstatMatchIds,
} from '../../src/services/understat-sync.service';

const teams: UnderstatTeam[] = [1, 2, 3].map((id) => ({
  id,
  title: `Team ${id}`,
  shortTitle: null,
  firstSeenSeason: '2627',
  lastSeenSeason: '2627',
  sourceHash: String(id),
}));

function match(id: number, ageHours: number, isResult = true): UnderstatMatch {
  return {
    id,
    season: '2627',
    homeTeamId: 1,
    awayTeamId: 2,
    kickoffAt: new Date(Date.UTC(2026, 7, 10) - ageHours * 60 * 60 * 1000),
    isResult,
    homeGoals: isResult ? 1 : null,
    awayGoals: isResult ? 0 : null,
    homeXg: isResult ? 1 : null,
    awayXg: isResult ? 0 : null,
    forecastHomeWin: null,
    forecastDraw: null,
    forecastAwayWin: null,
    sourceHash: String(id),
    sourceCheckedAt: new Date(),
    lastSeenAt: new Date(),
  };
}

describe('Understat incremental selection', () => {
  test('requires a complete EPL league snapshot before persistence', () => {
    expect(() => assertUnderstatLeagueSnapshotComplete('EPL', 20, 380)).not.toThrow();
    expect(() => assertUnderstatLeagueSnapshotComplete('EPL', 20, 379)).toThrow(
      'Incomplete Understat EPL snapshot',
    );
  });

  test('rejects disappearance of a previously persisted match ID', () => {
    expect(() => assertNoUnderstatMatchesDisappeared([1, 2], [match(1, 100)])).toThrow(
      'dropped known match IDs: 2',
    );
  });

  test('identifies completed matches withdrawn by a new discovery', () => {
    expect(
      withdrawnUnderstatMatchIds(
        [match(1, 100, true), match(2, 100, false)],
        [match(1, 100, false), match(2, 100, false)],
      ),
    ).toEqual([1]);
  });

  test('detects lane-owned team and player changes independently', () => {
    expect(
      changedUnderstatTeamStatIds(
        [
          { matchId: 10, teamId: 1, sourceHash: 'same' },
          { matchId: 10, teamId: 2, sourceHash: 'new' },
        ],
        new Map([
          ['10:1', 'same'],
          ['10:2', 'old'],
        ]),
      ),
    ).toEqual(new Set([2]));
    expect(
      changedUnderstatPlayerSeasonIds(
        [{ playerId: 100, sourceHash: 'same' }],
        new Map([
          [100, 'same'],
          [101, 'removed'],
        ]),
      ),
    ).toEqual(new Set([101]));
    expect(
      changedUnderstatPlayerSeasonIds(
        [{ playerId: 100, sourceHash: 'same' }],
        new Map([
          [100, 'same'],
          [101, 'omitted-from-partial-response'],
        ]),
        false,
      ),
    ).toEqual(new Set());
  });

  test('adds the destination team for changed player memberships', () => {
    expect(
      changedUnderstatPlayerTeamIds(
        [
          { playerId: 100, sourceTeamTitle: 'Crystal Palace, Arsenal' },
          { playerId: 101, sourceTeamTitle: 'Liverpool' },
        ],
        new Set([100]),
        [
          { id: 10, title: 'Crystal Palace' },
          { id: 11, title: 'Arsenal' },
          { id: 12, title: 'Liverpool' },
        ],
      ),
    ).toEqual(new Set([11]));
  });

  test('unions explicit, changed, and unsettled team detail targets', () => {
    expect(mergeUnderstatTeamDetailIds([3], new Set([1, 2]), [2, 4])).toEqual([1, 2, 3, 4]);
  });

  test('refreshes only changed or missing team pages', () => {
    expect(
      selectTeamDetailIds({
        mode: 'incremental',
        teams,
        changedTeamIds: new Set([2]),
        existingTeamIds: new Set([1, 2]),
        reconcileAll: true,
      }),
    ).toEqual([2, 3]);
  });

  test('selects unsynced and 72-hour correction matches without future fixtures', () => {
    const now = new Date(Date.UTC(2026, 7, 10));
    expect(
      selectPlayerMatchIds({
        mode: 'incremental',
        matches: [match(1, 100), match(2, 24), match(3, -24, false)],
        syncedMatchIds: new Set([1, 2]),
        now,
      }),
    ).toEqual([2]);
    expect(
      selectPlayerMatchIds({
        mode: 'incremental',
        matches: [match(1, 100)],
        syncedMatchIds: new Set(),
        now,
      }),
    ).toEqual([1]);
  });

  test('always includes old roster matches required by changed player totals', () => {
    const now = new Date(Date.UTC(2026, 7, 10));
    expect(
      selectPlayerMatchIds({
        mode: 'incremental',
        matches: [match(10, 100), match(11, 100)],
        syncedMatchIds: new Set([10, 11]),
        requiredMatchIds: new Set([11]),
        now,
      }),
    ).toEqual([11]);
  });
});
