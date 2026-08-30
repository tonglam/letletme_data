import { describe, expect, test } from 'bun:test';

import {
  resolveTournamentReviewFormat,
  tournamentReviewFailureFingerprint,
  tournamentReviewRetryDelayMs,
} from '../../src/services/tournament-review-publication.service';

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
});
