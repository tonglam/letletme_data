import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  canSkipMissingDetailDuringSeed,
  parseLiveMatchSeedArguments,
} from '../../scripts/seed-live-matches-v2';

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

  it('only skips missing detail for blank or genuinely pre-deadline scopes', () => {
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 0, state: 'LIVE_ACTIVE' })).toBe(true);
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 2, state: 'PRE_DEADLINE' })).toBe(true);
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 2, state: 'LIVE_ACTIVE' })).toBe(false);
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 2, state: 'DAY_SETTLING' })).toBe(false);
    expect(canSkipMissingDetailDuringSeed({ fixtureCount: 2, state: 'FINALIZED' })).toBe(false);
  });

  it('keeps the checked-in deploy helper on the same Match V2 seed path', () => {
    const deploy = readFileSync(new URL('../../scripts/deploy.sh', import.meta.url), 'utf8');
    expect(deploy).toMatch(
      /bun run db:cutover-seed-live-match-v2 -- --execute --all-finalized[\s\S]*--season "\$LIVE_POINTS_V2_SEED_SEASON"[\s\S]*--event-id "\$LIVE_POINTS_V2_SEED_EVENT_ID"/,
    );
  });
});
