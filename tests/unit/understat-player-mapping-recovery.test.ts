import { describe, expect, test } from 'bun:test';

import {
  classifyQuarantinedProviderPlayerMapping,
  PLAYER_RECOVERY_RULE_ID,
} from '../../src/services/provider-matcher.service';
import { parseRecoveryArguments } from '../../scripts/recover-understat-player-mappings';

const baseLink = {
  reviewedBy: null,
  method: 'verified-match-roster-bipartite',
  evidence: { confirmedSeasons: ['2526'] },
} as const;

describe('Understat player mapping recovery', () => {
  test('classifies a previously confirmed pair with two complete observations as recoverable', () => {
    expect(
      classifyQuarantinedProviderPlayerMapping({
        link: baseLink,
        season: '2627',
        understatPlayerId: 5232,
        fplPlayerCode: 219168,
        observedCandidates: new Set([5232]),
        observedMatchIds: [31180, 31181],
        hasVerifiedConflict: false,
      }),
    ).toEqual({
      disposition: 'recoverable',
      reasonCodes: ['PRIOR_IDENTITY_AND_COMPLETE_MATCH_EVIDENCE'],
    });
  });

  test('does not treat a single match or missing prior season as enough evidence', () => {
    const result = classifyQuarantinedProviderPlayerMapping({
      link: { ...baseLink, evidence: {} },
      season: '2627',
      understatPlayerId: 5232,
      fplPlayerCode: 219168,
      observedCandidates: new Set([5232]),
      observedMatchIds: [31180],
      hasVerifiedConflict: false,
    });
    expect(result.disposition).toBe('insufficient_evidence');
    expect(result.reasonCodes).toEqual([
      'OBSERVED_MATCHES_BELOW_MINIMUM',
      'NO_PRIOR_CONFIRMED_SEASON',
    ]);
  });

  test('keeps same-name multiple candidates out of automatic recovery', () => {
    const result = classifyQuarantinedProviderPlayerMapping({
      link: baseLink,
      season: '2627',
      understatPlayerId: 5232,
      fplPlayerCode: 219168,
      observedCandidates: new Set([5232, 6111]),
      observedMatchIds: [31180, 31181],
      hasVerifiedConflict: false,
    });
    expect(result).toEqual({
      disposition: 'insufficient_evidence',
      reasonCodes: ['MULTIPLE_IDENTITY_CANDIDATES'],
    });
    expect(
      classifyQuarantinedProviderPlayerMapping({
        link: baseLink,
        season: '2627',
        understatPlayerId: 5232,
        fplPlayerCode: 219168,
        observedCandidates: new Set([5232]),
        observedMatchIds: [31180, 31181],
        hasVerifiedConflict: false,
        hasAmbiguousObservation: true,
      }),
    ).toEqual({
      disposition: 'insufficient_evidence',
      reasonCodes: ['MULTIPLE_IDENTITY_CANDIDATES'],
    });
  });

  test('preserves manual review and verified conflicts as separate dispositions', () => {
    expect(
      classifyQuarantinedProviderPlayerMapping({
        link: { ...baseLink, reviewedBy: 'operator' },
        season: '2627',
        understatPlayerId: 5232,
        fplPlayerCode: 219168,
        observedCandidates: new Set([5232]),
        observedMatchIds: [31180, 31181],
        hasVerifiedConflict: false,
      }).disposition,
    ).toBe('manual_review');
    expect(
      classifyQuarantinedProviderPlayerMapping({
        link: baseLink,
        season: '2627',
        understatPlayerId: 5232,
        fplPlayerCode: 219168,
        observedCandidates: new Set([5232]),
        observedMatchIds: [31180, 31181],
        hasVerifiedConflict: true,
      }).disposition,
    ).toBe('identity_conflict');
  });

  test('requires an approval file for any applying invocation', () => {
    expect(parseRecoveryArguments(['--season', '2627'])).toEqual({
      season: '2627',
      apply: false,
      approvedFile: null,
    });
    expect(() => parseRecoveryArguments(['--season', '2627', '--apply'])).toThrow(
      '--apply requires --approved-file',
    );
    expect(() =>
      parseRecoveryArguments(['--season', '2627', '--approved-file', 'approved.json']),
    ).toThrow('--approved-file requires --apply');
    expect(
      parseRecoveryArguments(['--season', '2627', '--apply', '--approved-file', 'approved.json']),
    ).toEqual({
      season: '2627',
      apply: true,
      approvedFile: 'approved.json',
    });
  });

  test('uses the versioned recovery rule for restored links', () => {
    expect(PLAYER_RECOVERY_RULE_ID).toBe('understat-fpl-player-roster-recovery-v1');
  });
});
