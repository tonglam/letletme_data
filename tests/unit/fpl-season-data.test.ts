import { describe, expect, test } from 'bun:test';

import { normalizeFplFixtureKickoffAt } from '../../src/repositories/fpl-season-data';

describe('FPL season fixture timestamps', () => {
  test('normalizes session-pool timestamp strings to Date instances', () => {
    const value = normalizeFplFixtureKickoffAt('2026-08-21T17:30:00.000Z');

    expect(value).toBeInstanceOf(Date);
    expect(value?.toISOString()).toBe('2026-08-21T17:30:00.000Z');
  });

  test('copies Date instances and preserves null', () => {
    const source = new Date('2026-08-21T17:30:00.000Z');
    const value = normalizeFplFixtureKickoffAt(source);

    expect(value).toBeInstanceOf(Date);
    expect(value).not.toBe(source);
    expect(value?.toISOString()).toBe(source.toISOString());
    expect(normalizeFplFixtureKickoffAt(null)).toBeNull();
  });

  test('rejects invalid provider timestamps', () => {
    expect(() => normalizeFplFixtureKickoffAt('not-a-date')).toThrow(
      'FPL fixture kickoffAt is not a valid timestamp',
    );
  });
});
