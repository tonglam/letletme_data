import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import {
  hasCompleteTournamentReviewH2HGroupCoverage,
  h2hMatchPointsMatchScore,
  isTournamentReviewEntryApplicable,
  rankTournamentReviewH2HStandings,
  resolveTournamentReviewFormat,
  tournamentReviewScoreMatchesEntryResult,
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

  test('accepts only score-derived H2H match points', () => {
    expect(h2hMatchPointsMatchScore(70, 55, 3, 0)).toBe(true);
    expect(h2hMatchPointsMatchScore(70, 55, 1, 1)).toBe(false);
    expect(h2hMatchPointsMatchScore(55, 55, 1, 1)).toBe(true);
    expect(h2hMatchPointsMatchScore(55, 55, 3, 0)).toBe(false);
  });

  test('requires derived matchup scores to cover the entry result watermark', () => {
    const result = {
      event_net_points: 70,
      updated_at: '2026-08-30T10:00:00.000Z',
      rich_synced_at: '2026-08-30T09:59:00.000Z',
    };
    expect(
      tournamentReviewScoreMatchesEntryResult(
        70,
        '2026-08-30T10:01:00.000Z',
        '2026-08-30T10:02:00.000Z',
        result,
      ),
    ).toBe(true);
    expect(
      tournamentReviewScoreMatchesEntryResult(
        69,
        '2026-08-30T10:01:00.000Z',
        '2026-08-30T10:02:00.000Z',
        result,
      ),
    ).toBe(false);
    expect(
      tournamentReviewScoreMatchesEntryResult(
        70,
        '2026-08-30T09:58:00.000Z',
        '2026-08-30T09:58:00.000Z',
        result,
      ),
    ).toBe(false);
    expect(tournamentReviewScoreMatchesEntryResult(70, null, null, null)).toBe(false);
  });

  test('reconciles incrementally and retires scopes under the publication lock', () => {
    expect(publicationSource).toContain('COALESCE(state.existing_eligible_at');
    expect(publicationSource).toContain('event.updated_at AS event_updated_at');
    expect(publicationSource).toContain('const eventMetadataChanged =');
    expect(publicationSource).toContain('eventMetadataChanged ? [event.updated_at] : []');
    expect(publicationSource).toContain('previous.payload AS existing_payload');
    expect(publicationSource).toContain('tournament.updated_at AS tournament_updated_at');
    expect(publicationSource).toContain('tournamentMetadataChanged');
    expect(publicationSource).toContain('history_group_mismatch_count');
    expect(publicationSource).toContain('points group ranks are inconsistent');
    expect(publicationSource).toContain('payload_row->>\x27applicable\x27');
    expect(publicationSource).toContain('state.existing_eligible_at IS NULL');
    expect(publicationSource).toContain('state.existing_payload IS NOT NULL');
    expect(publicationSource).toMatch(/state\.existing_payload->'points'->'rows'/);
    expect(publicationSource).toMatch(/state\.existing_payload->'h2h'->'standings'/);
    expect(publicationSource).toMatch(/state\.existing_payload->'knockout'->'matches'/);
    expect(publicationSource).toContain('payload #>>');
    expect(publicationSource).toContain('await tx`');
    expect(publicationSource).toContain('pg_advisory_xact_lock');
    expect(publicationSource).toContain('locked_stale_scopes AS MATERIALIZED');
    expect(publicationSource).toContain('DELETE FROM competition.tournament_review_heads');
    expect(publicationSource).toContain('DELETE FROM competition.tournament_review_obligations');
    expect(publicationSource).toContain('\x27review:\x27 || ${season.seasonId}::text');
  });

  test('includes entry metadata and validated cumulative history in provenance', () => {
    expect(publicationSource).toContain('entry.updated_at AS entry_updated_at');
    expect(publicationSource).toContain('const eventMetadataChanged =');
    expect(publicationSource).toContain('eventMetadataChanged ? [event.updated_at] : []');
    expect(publicationSource).toContain('COALESCE(entry.started_event, 1)');
    expect(publicationSource).toContain('history_sources.source_min_checked_at');
    expect(publicationSource).toContain('sourceTimes.push(...historySourceDates)');
    expect(publicationSource).toContain(
      'sourceTimes.push(...brackets.map((bracket) => bracket.updated_at))',
    );
    expect(publicationSource).toContain('knockout match source is stale');
  });
});
