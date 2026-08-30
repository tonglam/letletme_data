import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import {
  hasCompleteTournamentReviewH2HGroupCoverage,
  isTournamentReviewEntryApplicable,
  rankTournamentReviewH2HStandings,
  resolveTournamentReviewFormat,
  tournamentReviewFailureFingerprint,
  tournamentReviewRetryDelayMs,
} from '../../src/services/tournament-review-publication.service';

const publicationSource = readFileSync(
  'src/services/tournament-review-publication.service.ts',
  'utf8',
);

describe('My Tournament Review V2 format and retry policy', () => {
  test('uses one mutually-exclusive format per finalized event', () => {
    const config = {
      groupMode: 'points_races' as const,
      groupStartedEventId: 1,
      groupEndedEventId: 10,
      knockoutMode: 'single_elimination' as const,
      knockoutStartedEventId: 11,
      knockoutEndedEventId: 13,
    };
    expect(resolveTournamentReviewFormat(config, 10)).toBe('POINTS');
    expect(resolveTournamentReviewFormat(config, 11)).toBe('KNOCKOUT');
    expect(resolveTournamentReviewFormat(config, 14)).toBeNull();
    expect(
      resolveTournamentReviewFormat(
        { ...config, groupMode: 'battle_races', knockoutMode: 'no_knockout' },
        5,
      ),
    ).toBe('H2H');
  });

  test('keeps source rechecks separate from execution retries', () => {
    expect(tournamentReviewRetryDelayMs('source', 1)).toBe(60_000);
    expect(tournamentReviewRetryDelayMs('source', 2)).toBe(180_000);
    expect(tournamentReviewRetryDelayMs('source', 3)).toBe(600_000);
    expect(tournamentReviewRetryDelayMs('source', 4)).toBeNull();
    expect(tournamentReviewRetryDelayMs('execution', 1)).toBe(60_000);
    expect(tournamentReviewRetryDelayMs('execution', 2)).toBe(300_000);
    expect(tournamentReviewRetryDelayMs('execution', 3)).toBe(900_000);
    expect(tournamentReviewRetryDelayMs('execution', 4)).toBeNull();
  });

  test('fingerprints failure dimensions without persisting raw errors', () => {
    const first = tournamentReviewFailureFingerprint('SOURCE', '6953:1:5:1');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(tournamentReviewFailureFingerprint('SOURCE', '6953:1:5:1'));
    expect(first).not.toBe(tournamentReviewFailureFingerprint('SOURCE', '6953:1:5:2'));
  });

  test('validates H2H fixture coverage independently for every group', () => {
    const eligibleEntryIds = new Set([1, 2, 3, 4, 5, 6]);
    const entryGroupIds = new Map([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
      [6, 2],
    ]);
    expect(
      hasCompleteTournamentReviewH2HGroupCoverage({
        eligibleEntryIds,
        entryGroupIds,
        matchCountByGroup: new Map([
          [1, 2],
          [2, 2],
        ]),
        averageSidesByGroup: new Map([
          [1, 1],
          [2, 1],
        ]),
      }),
    ).toBe(true);
    expect(
      hasCompleteTournamentReviewH2HGroupCoverage({
        eligibleEntryIds,
        entryGroupIds,
        matchCountByGroup: new Map([
          [1, 2],
          [2, 1],
        ]),
        averageSidesByGroup: new Map([
          [1, 1],
          [2, 0],
        ]),
      }),
    ).toBe(false);
  });

  test('represents pre-entry H2H participants without treating their scores as ready', () => {
    expect(isTournamentReviewEntryApplicable(null, 5)).toBe(true);
    expect(isTournamentReviewEntryApplicable(5, 5)).toBe(true);
    expect(isTournamentReviewEntryApplicable(6, 5)).toBe(false);
  });

  test('uses competition ranking for tied H2H scoring keys', () => {
    expect(
      rankTournamentReviewH2HStandings([
        { entryId: 3, matchPoints: 6, pointsFor: 120 },
        { entryId: 1, matchPoints: 6, pointsFor: 120 },
        { entryId: 2, matchPoints: 3, pointsFor: 110 },
      ]).map(({ entryId, rank }) => ({ entryId, rank })),
    ).toEqual([
      { entryId: 1, rank: 1 },
      { entryId: 3, rank: 1 },
      { entryId: 2, rank: 3 },
    ]);
  });

  test('reconciles incrementally and retires scopes under the publication lock', () => {
    expect(publicationSource).toContain('> existing.eligible_at');
    expect(publicationSource).toContain('locked_stale_scopes AS MATERIALIZED');
    expect(publicationSource).toContain('DELETE FROM competition.tournament_review_heads');
    expect(publicationSource).toContain('DELETE FROM competition.tournament_review_obligations');
    expect(publicationSource).toContain('\x27review:\x27 || ${season.seasonId}::text');
  });

  test('includes entry metadata and validated cumulative history in provenance', () => {
    expect(publicationSource).toContain('entry.updated_at AS entry_updated_at');
    expect(publicationSource).toContain('history_sources.source_min_checked_at');
    expect(publicationSource).toContain('sourceTimes.push(...historySourceDates)');
  });
});
