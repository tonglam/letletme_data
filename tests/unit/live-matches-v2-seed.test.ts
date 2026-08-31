import { describe, expect, it } from 'bun:test';

import { parseLiveMatchSeedArguments } from '../../scripts/seed-live-matches-v2';

describe('live match V2 cutover seed arguments', () => {
  it('requires execution, season, and either a target or finalized sweep', () => {
    expect(
      parseLiveMatchSeedArguments(['--execute', '--season', '2627', '--event-id', '2']),
    ).toEqual({ execute: true, allFinalized: false, season: '2627', eventId: 2 });
    expect(
      parseLiveMatchSeedArguments(['--execute', '--all-finalized', '--season', '2627']),
    ).toEqual({ execute: true, allFinalized: true, season: '2627', eventId: null });
  });

  it('rejects an unsafe or incomplete cutover scope', () => {
    expect(() => parseLiveMatchSeedArguments(['--season', '2627', '--event-id', '2'])).toThrow();
    expect(() => parseLiveMatchSeedArguments(['--execute', '--season', '2627'])).toThrow();
    expect(() =>
      parseLiveMatchSeedArguments([
        '--execute',
        '--all-finalized',
        '--event-id',
        '0',
        '--season',
        '2627',
      ]),
    ).toThrow();
    expect(() =>
      parseLiveMatchSeedArguments([
        '--execute',
        '--season',
        '2627',
        '--season',
        '2627',
        '--event-id',
        '2',
      ]),
    ).toThrow();
  });
});
