import { describe, expect, test } from 'bun:test';

import { buildFixtureRepairCachePlan } from '../../src/cache/fixtures-cache';
import type { Fixture } from '../../src/types';

function fixture(id: number, event: number, teamH: number, teamA: number): Fixture {
  return {
    id,
    code: id,
    event,
    teamH,
    teamA,
    teamHScore: null,
    teamAScore: null,
    teamHDifficulty: 2,
    teamADifficulty: 3,
    kickoffTime: new Date(`2026-08-${String(event).padStart(2, '0')}T12:00:00Z`),
    started: false,
    finished: false,
    minutes: 0,
    provisionalStartTime: false,
    finishedProvisional: false,
    pulseId: 0,
    stats: [],
    createdAt: null,
    updatedAt: null,
  };
}

describe('fixture repair cache plan', () => {
  test('rebuilds affected event hashes without dropping unrelated canonical rows', () => {
    const fixtures = [fixture(101, 1, 1, 2), fixture(102, 2, 1, 3), fixture(103, 1, 4, 2)];
    const teams = new Map([
      [1, { name: 'One', shortName: 'ONE' }],
      [2, { name: 'Two', shortName: 'TWO' }],
      [3, { name: 'Three', shortName: 'THR' }],
      [4, { name: 'Four', shortName: 'FO' }],
    ]);

    const plan = buildFixtureRepairCachePlan('2627', fixtures, [1, 2, 1], [1, 2], teams);

    expect(Object.keys(plan.hashes.get('Fixtures:2627:1') ?? {}).sort()).toEqual(['101', '103']);
    expect(Object.keys(plan.hashes.get('Fixtures:2627:2') ?? {})).toEqual(['102']);
    expect(Object.keys(plan.hashes.get('FixturesByTeam:2627:1') ?? {}).sort()).toEqual(['1', '2']);
    expect(Object.keys(plan.hashes.get('FixturesByTeam:2627:2') ?? {})).toEqual(['1']);
  });

  test('publishes an empty affected hash as a delete-only replacement', () => {
    const plan = buildFixtureRepairCachePlan('2627', [], [7], [], new Map());
    expect(plan.hashes.get('Fixtures:2627:7')).toEqual({});
  });
});
