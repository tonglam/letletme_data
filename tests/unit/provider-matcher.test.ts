import { describe, expect, test } from 'bun:test';

import {
  candidatesWithMinimumMatchObservations,
  fixtureOutcomeEvidenceAligns,
  hasCompleteRosterEvidence,
  hasUnderstatFixtureParticipation,
  normalizeProviderPlayerName,
  isAutoMappingProtectedStatus,
  providerPlayerNamesMatch,
  providerTeamConfirmedForSeason,
  resolveUniqueProviderAssignments,
  rosterEvidenceAligns,
  shouldConfirmProviderPlayerSeason,
  understatMinutesMatchEvidence,
  verifiedPlayerMappingConflict,
} from '../../src/services/provider-matcher.service';

const fpl = {
  fixtureCode: 100,
  playerCode: 200,
  teamCode: 3,
  elementType: 3,
  minutes: 89,
  starts: 1,
  goals: 1,
  assists: 0,
  ownGoals: 0,
  yellowCards: 1,
  redCards: 0,
  name: 'Benjamin Example',
  nameAvailable: true,
};

const understat = {
  matchId: 300,
  playerId: 400,
  teamId: 83,
  position: 'AMC',
  seasonPosition: 'M',
  minutes: 90,
  started: true,
  goals: 1,
  assists: 1,
  ownGoals: 0,
  yellowCards: 1,
  redCards: 0,
  name: 'Benjamin Example',
};

describe('provider roster matcher', () => {
  test('requires an explicit team confirmation for the requested season', () => {
    const link = {
      id: 'link',
      entityType: 'team' as const,
      leftProvider: 'understat',
      leftEntityId: '83',
      rightProvider: 'fpl',
      rightEntityId: '3',
      status: 'manual_verified' as const,
      method: 'manual',
      ruleId: 'test-team-confirmation',
      evidence: { confirmedSeasons: ['2627', '2829'] },
      firstSeenSeason: '2627',
      lastSeenSeason: '2829',
      reviewedBy: 'operator',
      reviewedAt: new Date(),
    };
    expect(providerTeamConfirmedForSeason(link, '2627')).toBe(true);
    expect(providerTeamConfirmedForSeason(link, '2728')).toBe(false);
  });

  test('rejects verified player mappings that break one-to-one identity', () => {
    const verified = {
      id: 'verified-link',
      entityType: 'player' as const,
      leftProvider: 'understat',
      leftEntityId: '8094',
      rightProvider: 'fpl',
      rightEntityId: '123',
      status: 'manual_verified' as const,
      method: 'manual',
      ruleId: 'test',
      evidence: {},
      firstSeenSeason: '2627',
      lastSeenSeason: '2627',
      reviewedBy: 'operator',
      reviewedAt: new Date(),
    };
    expect(verifiedPlayerMappingConflict([verified], 8094, 466052)?.id).toBe('verified-link');
    expect(verifiedPlayerMappingConflict([verified], 8094, 123)).toBeUndefined();
  });

  test('requires the season aggregate minutes to equal fixture evidence', () => {
    expect(understatMinutesMatchEvidence(108, [60, 48])).toBe(true);
    expect(understatMinutesMatchEvidence(108, [60, 47])).toBe(false);
  });

  test('never silently rebinds verified or quarantined identities', () => {
    expect(isAutoMappingProtectedStatus('auto_verified')).toBe(true);
    expect(isAutoMappingProtectedStatus('manual_verified')).toBe(true);
    expect(isAutoMappingProtectedStatus('quarantined')).toBe(true);
    expect(isAutoMappingProtectedStatus('rejected')).toBe(true);
    expect(isAutoMappingProtectedStatus('ambiguous')).toBe(false);
    expect(isAutoMappingProtectedStatus('pending')).toBe(false);
  });

  test('confirms a previously verified player link for a newly observed season', () => {
    const link = {
      status: 'auto_verified' as const,
      evidence: { confirmedSeasons: ['2526'] },
    };
    expect(shouldConfirmProviderPlayerSeason(link, '2627', 1)).toBe(true);
    expect(shouldConfirmProviderPlayerSeason(link, '2627', 0)).toBe(false);
    expect(
      shouldConfirmProviderPlayerSeason(
        { status: 'auto_verified', evidence: { confirmedSeasons: ['2627'] } },
        '2627',
        1,
      ),
    ).toBe(false);
    expect(
      shouldConfirmProviderPlayerSeason(
        { status: 'pending', evidence: { confirmedSeasons: ['2526'] } },
        '2627',
        1,
      ),
    ).toBe(false);
  });

  test('uses exact names and mapped teams while allowing provider stat differences', () => {
    expect(rosterEvidenceAligns(fpl, understat, 3)).toBe(true);
    expect(rosterEvidenceAligns(fpl, { ...understat, redCards: 1, minutes: 92 }, 3)).toBe(true);
    expect(rosterEvidenceAligns(fpl, understat, 4)).toBe(false);
    expect(rosterEvidenceAligns(fpl, { ...understat, name: 'Different Example' }, 3)).toBe(false);
    expect(
      rosterEvidenceAligns({ ...fpl, name: 'Example' }, { ...understat, name: 'Example' }, 3),
    ).toBe(false);
  });

  test('keeps all provider statistics source-specific during fixture verification', () => {
    expect(fixtureOutcomeEvidenceAligns(fpl, understat, 3)).toBe(true);
    expect(
      fixtureOutcomeEvidenceAligns(
        { ...fpl, minutes: 63, goals: 2, yellowCards: 1 },
        { ...understat, minutes: 66, goals: 1, redCards: 1 },
        3,
      ),
    ).toBe(true);
    expect(fixtureOutcomeEvidenceAligns(fpl, understat, 4)).toBe(false);
  });

  test('accepts Isak-style minute and position differences with an exact name', () => {
    expect(
      rosterEvidenceAligns(
        { ...fpl, name: 'Alexander Isak', elementType: 4, teamCode: 14, minutes: 63 },
        { ...understat, name: 'Alexander Isak', position: 'FW', minutes: 66 },
        14,
      ),
    ).toBe(true);
  });

  test('requires both complete starting elevens before using a match as identity evidence', () => {
    const starters = [
      ...Array.from({ length: 11 }, (_, index) => ({ teamId: 1, started: true, playerId: index })),
      ...Array.from({ length: 11 }, (_, index) => ({
        teamId: 2,
        started: true,
        playerId: index + 11,
      })),
    ];
    expect(hasCompleteRosterEvidence(starters)).toBe(true);
    expect(hasCompleteRosterEvidence(starters.slice(1))).toBe(false);
    expect(hasCompleteRosterEvidence([...starters, { teamId: 3, started: true }])).toBe(false);
    expect(
      hasCompleteRosterEvidence(
        starters.map((row, index) => (index === 1 ? { ...row, playerId: 0 } : row)),
      ),
    ).toBe(false);
  });

  test('normalizes full names and accepts only explicit trusted aliases', () => {
    expect(normalizeProviderPlayerName('  Álex.  Isak ')).toBe('alex isak');
    expect(normalizeProviderPlayerName('Martin Ødegaard')).toBe('martin odegaard');
    expect(normalizeProviderPlayerName('Nico O&#039;Reilly')).toBe('nico o reilly');
    expect(normalizeProviderPlayerName('Nico O\u0026#x27;Reilly')).toBe('nico o reilly');
    expect(providerPlayerNamesMatch('Alexander Isak', 'alexander isak')).toBe(true);
    expect(providerPlayerNamesMatch('Martin Odegaard', 'Martin Ødegaard')).toBe(true);
    expect(providerPlayerNamesMatch('Nico O Reilly', 'Nico O&#039;Reilly')).toBe(true);
    expect(providerPlayerNamesMatch('Alexander Isak', 'Isak')).toBe(false);
    expect(
      providerPlayerNamesMatch('Alexander Isak', 'Alex Isaksson', {
        fpl: ['Alex Isaksson'],
        understat: [],
      }),
    ).toBe(true);
    expect(
      providerPlayerNamesMatch('Alexander Isak', 'Alexander Isaksson', {
        fpl: [],
        understat: [],
      }),
    ).toBe(false);
    expect(rosterEvidenceAligns({ ...fpl, name: 'Isak', nameAvailable: false }, understat, 3)).toBe(
      false,
    );
    expect(
      rosterEvidenceAligns({ ...fpl, name: 'Isak', nameAvailable: false }, understat, 3, {
        fpl: ['Benjamin Example'],
        understat: [],
      }),
    ).toBe(true);
  });

  test('ignores only a true zero-participation Understat bench row', () => {
    const unused = {
      minutes: 0,
      started: false,
      goals: 0,
      assists: 0,
      ownGoals: 0,
      yellowCards: 0,
      redCards: 0,
    };
    expect(hasUnderstatFixtureParticipation(unused)).toBe(false);
    expect(hasUnderstatFixtureParticipation({ ...unused, minutes: 1 })).toBe(true);
    expect(hasUnderstatFixtureParticipation({ ...unused, yellowCards: 1 })).toBe(true);
    expect(hasUnderstatFixtureParticipation({ ...unused, started: true })).toBe(true);
  });

  test('requires two independent verified-match observations before auto verification', () => {
    const candidates = new Map([[200, new Set([400, 401])]]);
    const eligible = candidatesWithMinimumMatchObservations(
      candidates,
      new Map([
        ['200:400', new Set([300])],
        ['200:401', new Set([300, 301])],
      ]),
    );
    expect(eligible).toEqual(new Map([[200, new Set([401])]]));
  });

  test('leaves indistinguishable zero-event players unresolved', () => {
    const assignments = resolveUniqueProviderAssignments(
      new Map([
        [10, new Set([100, 101])],
        [11, new Set([100, 101])],
      ]),
    );
    expect(assignments.size).toBe(0);
  });

  test('resolves only forced one-to-one assignments', () => {
    const assignments = resolveUniqueProviderAssignments(
      new Map([
        [10, new Set([100])],
        [11, new Set([100, 101])],
        [12, new Set([102])],
      ]),
    );
    expect(assignments).toEqual(
      new Map([
        [10, 100],
        [11, 101],
        [12, 102],
      ]),
    );
  });
});
