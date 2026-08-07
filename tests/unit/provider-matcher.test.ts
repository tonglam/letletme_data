import { describe, expect, test } from 'bun:test';

import {
  candidatesWithMinimumMatchObservations,
  isAutoMappingProtectedStatus,
  providerTeamConfirmedForSeason,
  resolveUniqueProviderAssignments,
  rosterEvidenceCompatible,
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
  name: 'Completely Different Name',
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
      ruleVersion: 'v1',
      evidence: { confirmedSeasons: ['2627', '2829'] },
      firstSeenSeason: '2627',
      lastSeenSeason: '2829',
      reviewedBy: 'operator',
      reviewedAt: new Date(),
    };
    expect(providerTeamConfirmedForSeason(link, '2627')).toBe(true);
    expect(providerTeamConfirmedForSeason(link, '2728')).toBe(false);
  });

  test('never silently rebinds verified or quarantined identities', () => {
    expect(isAutoMappingProtectedStatus('auto_verified')).toBe(true);
    expect(isAutoMappingProtectedStatus('manual_verified')).toBe(true);
    expect(isAutoMappingProtectedStatus('quarantined')).toBe(true);
    expect(isAutoMappingProtectedStatus('ambiguous')).toBe(false);
    expect(isAutoMappingProtectedStatus('pending')).toBe(false);
  });

  test('uses provider evidence rather than names, with assists only auxiliary', () => {
    expect(rosterEvidenceCompatible(fpl, understat, 3)).toBe(true);
    expect(rosterEvidenceCompatible(fpl, { ...understat, redCards: 1 }, 3)).toBe(false);
    expect(rosterEvidenceCompatible(fpl, understat, 4)).toBe(false);
    expect(rosterEvidenceCompatible({ ...fpl, starts: null }, understat, 3)).toBe(true);
    expect(
      rosterEvidenceCompatible({ ...fpl, starts: null }, { ...understat, started: false }, 3),
    ).toBe(true);
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
